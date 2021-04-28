import json
import os
import sys

from .exceptions import *

from elasticsearch import Elasticsearch
import elasticsearch.helpers as esh


class Ivis:
    """Helper class for ivis tasks"""

    def __init__(self):
        self._data = json.loads(sys.stdin.readline())
        self._elasticsearch = Elasticsearch([{'host': self._data['es']['host'], 'port': int(self._data['es']['port'])}])
        self.state = self._data.get('state')
        self.params = self._data['params']
        self.entities = self._data['entities']
        self.owned = self._data['owned']

    @property
    def elasticsearch(self):
        return self._elasticsearch

    @staticmethod
    def _get_response_message():
        msg = json.loads(sys.stdin.readline())
        error = msg.get('error')
        if error:
            raise RequestException(error)
        return msg

    @staticmethod
    def _send_request_message(msg):
        os.write(3, (json.dumps(msg) + '\n').encode())

    def create_signals(self, signal_sets=None, signals=None):
        msg = {
            'type': 'create_signals',
        }

        if signal_sets is not None:
            msg['signalSets'] = signal_sets

        if signals is not None:
            msg['signals'] = signals

        Ivis._send_request_message(msg)
        response = Ivis._get_response_message()

        # Add newly created to owned
        for sig_set_cid, set_props in response.items():
            signals_created = set_props.pop('signals', {})
            if signal_sets is not None:
                # Function allows passing in either array of signal sets or one signal set
                if (isinstance(signal_sets, list) and any(map(lambda s: s["cid"] == sig_set_cid, signal_sets))) or (
                        not isinstance(signal_sets, list) and signal_sets["cid"] == sig_set_cid):
                    self.owned.setdefault('signalSets', {}).setdefault(sig_set_cid, {})
            self.entities['signalSets'].setdefault(sig_set_cid, set_props)
            if signals_created:
                self.owned.setdefault('signals', {}).setdefault(sig_set_cid, {})
                for sigCid, sig_props in signals_created.items():
                    self.owned['signals'][sig_set_cid].setdefault(sigCid, {})
                    self.entities['signals'].setdefault(sig_set_cid, {}).setdefault(sigCid, sig_props)

        return response

    def create_signal_set(self, cid, namespace, name=None, description=None, record_id_template=None, signals=None):

        signal_set = {
            "cid": cid,
            "namespace": namespace
        }

        if name is not None:
            signal_set["name"] = name
        if description is not None:
            signal_set["description"] = description
        if record_id_template is not None:
            signal_set["record_id_template"] = record_id_template
        if signals is not None:
            signal_set['signals'] = signals

        return self.create_signals(signal_sets=signal_set)

    def create_signal(self, signal_set_cid, cid, namespace, type, name=None, description=None, indexed=None,
                      settings=None,
                      weight_list=None, weight_edit=None, **extra_keys):

        # built-in type is shadowed here because this way we are able to call create_signal(set_cid, **signal),
        # where signal is dictionary with same structure as json that is accepted by REST API for signal creation

        signal = {
            "cid": cid,
            "type": type,
            "namespace": namespace,
        }

        if indexed is not None:
            signal["indexed"] = indexed
        if settings is not None:
            signal["settings"] = settings
        if weight_list is not None:
            signal["weight_list"] = weight_list
        if weight_edit is not None:
            signal["weight_edit"] = weight_edit
        if name is not None:
            signal["name"] = name
        if description is not None:
            signal["description"] = description

        signal.update(extra_keys)

        signals = {signal_set_cid: signal}

        return self.create_signals(signals=signals)

    @staticmethod
    def store_state(state):
        msg = {
            "type": "store_state",
            "state": state
        }

        Ivis._send_request_message(msg)
        return Ivis._get_response_message()

    def get_signal_set_index(self, set_cid):
        """Return the elasticsearch index of a given signal set."""
        return self.entities['signalSets'][set_cid]['index']

    def get_signal_field(self, set_cid, signal_cid):
        """Return the field name of a given signal in given signal set used in es"""
        return self.entities['signals'][set_cid][signal_cid]['index']

    def translate_record(self, set_cid: str, record):
        """Translate records signal cids to corresponding elasticsearch fields

        Example usage:
        record = {
            'ts': '2021-01-01T00:00:00.000Z',
            'value': 42
        }

        record = ivis.translate_record('signal_set_cid', record)

        record is now:
        {
            's1': '2021-01-01T00:00:00.000Z',
            's2': 42
        }

        where s1, s2 are field names used by elasticsearch index storing the
        signal set
        """
        doc = {}
        for key, value in record.items():
            es_key = ivis.entities['signals'][set_cid][key]['field']
            doc[es_key] = value

        return doc

    def insert_record(self, set_cid: str, record):
        """Insert a single record into a signal set
        Args:
            set_cid (str): cid of the signal set
            record ([type]): dictionary containing signal values, indexed by signal cids (as opposed to real es fields)
        """
        index = self.get_signal_set_index(set_cid)
        doc = self.translate_record(set_cid, record)
        # TODO: Type may need to be removed in elastic 7+
        self.elasticsearch.index(index, doc_type='_doc', body=doc)

    def insert_records(self, set_cid: str, records):
        """Insert multiple records into a signal set. Elasticsearch Bulk API is
        used and consequently using  this method should be faster than inserting
        the records one by one.

        Args:
            set_cid (str): cid of the signal set
            records ([type]): iterable of records
        """
        def create_reqs(set_cid: str, docs):
            """Fill index and doctype so that we can use these requests in bulk
            """
            index = self.get_signal_set_index(set_cid)
            for doc in docs:
                yield {
                    '_index': index,
                    # TODO: Type may need to be removed in elastic 7+
                    '_type': '_doc',
                    **doc
                }
        docs = (self.translate_record(set_cid, record) for record in records)
        requests = create_reqs(set_cid, docs)
        esh.bulk(self.elasticsearch, requests)

    def clear_records(self, set_cid: str):
        """Deletes all records stored in a given (computed) signal set

        Args:
            set_cid (str): Signal set cid
        """
        index = self.get_signal_set_index(set_cid)

        # Originally, delete_by_query was used.
        # body = {'query': {'match_all': {}}}
        # ivis.elasticsearch.delete_by_query(index=index, body=body)

        # The problem with the original solution is that if .delete_by_query is
        # soon followed by .index, version_conflicts can occur.

        # Instead, index is now deleted and a new one is created.

        # The advantage of this solution, that index can be called immediately
        # after the index is created.

        # Get old index mappings so that we can migrate them to the new index
        mappings = ivis.elasticsearch.indices.get_mapping(index=index)
        # settings = ivis.elasticsearch.indices.get_settings(index=index)
        body = mappings[index]
        ivis.elasticsearch.indices.delete(index=index)
        ivis.elasticsearch.indices.create(index=index, body=body)


ivis = Ivis()
