'use strict';

const elasticsearch = require('../elasticsearch');
const {enforce} = require('../helpers');
const interoperableErrors = require('../../../shared/interoperable-errors');
const {IndexMethod} = require('../../../shared/signals');
const {SignalSetType} = require('../../../shared/signal-sets');
const {getIndexName, getFieldName, createIndex, extendMapping, COPY_ID_PIPELINE} = require('./elasticsearch-common');
const contextHelpers = require('../context-helpers');

const signalSets = require('../../models/signal-sets');
const em = require('../extension-manager');
const fork = require('child_process').fork;

const path = require('path');
const log = require('../log');

const {query} = require('./elasticsearch-query');

const insertBatchSize = 1000;

const indexerExec = em.get('indexer.elasticsearch.exec', path.join(__dirname, '..', '..', 'services', 'indexer-elasticsearch.js'));
const indexer = require('./elasticsearch-common');
const knex = require('../../lib/knex');

const {emitter, EventTypes}= require('../elasticsearch-events');


let indexerProcess;

async function init() {
    log.info('Indexer', 'Spawning indexer process');

    await initPipelines();

    const options = {
        cwd: path.join(__dirname, '..', '..'),
        env: {NODE_ENV: process.env.NODE_ENV}
    };

    if (process.env.NODE_ENV && process.env.NODE_ENV === 'development') {
        options.silent = false;
        options.execArgv = ['--inspect=0'];
    }

    indexerProcess = fork(indexerExec, [], options);

    let startedCallback;
    const startedPromise = new Promise((resolve, reject) => {
        startedCallback = resolve;
    });

    indexerProcess.on('message', msg => {
        if (msg) {
            switch (msg.type) {
                case 'started':
                    log.info('Indexer', 'Indexer process started');
                    return startedCallback();
                case 'index':
                    if (msg.cid) {
                        emitter.emit(EventTypes.INDEX, msg.cid);
                    }
                    break;
            }

        }
    });

    indexerProcess.on('close', (code, signal) => {
        log.info('Indexer', 'Indexer process exited with code %s signal %s.', code, signal);
    });

    await startedPromise;

    const sigSets = await signalSets.list();
    for (const sigSet of sigSets) {
        // TODO non existing indices for computed singal sets are not handled yet
        // it might cause problems. For example when clearing indices, starting ivis, jobs might expect index to exits.
        if (sigSet.type !== SignalSetType.COMPUTED) {
            await signalSets.index(contextHelpers.getAdminContext(), sigSet.id, IndexMethod.INCREMENTAL);
        } else {
            const indexName = getIndexName(sigSet);
            const exists = await elasticsearch.indices.exists({
                index: indexName
            });
            if (!exists) {
                await knex.transaction(async tx => {
                    const signalByCidMap = await signalSets.getSignalByCidMapTx(tx, sigSet);
                    await indexer.createIndex(sigSet, signalByCidMap);
                });
            }
        }
    }
}


async function initPipelines() {

    // When documents are added to generated signal set (in tasks), index is accessed directly
    // this pipeline assures that the _id field, if used, is copied to id field, which is used for sorting
    // as recommended by ES docs
    await elasticsearch.ingest.putPipeline(
        {
            id: COPY_ID_PIPELINE,
            body:
                {
                    "description": "Copy _id field to id field for sorting purposes",
                    "processors": [
                        {
                            "set": {
                                "if": "ctx._id != null",
                                "field": "id",
                                "value": "{{_id}}"
                            }
                        }
                    ]
                }
        }
    );
}

async function getDocsCount(sigSet) {
    const count = await elasticsearch.cat.count({index: getIndexName(sigSet), h: 'count'});
    return count.trim();
}

async function onCreateStorage(sigSet) {
    await createIndex(sigSet, {});
    return {};
}

async function onExtendSchema(sigSet, fields) {
    await extendMapping(sigSet, fields);
    return {};
}

async function onRemoveField(sigSet, fieldCid) {
    // Updating all records in the index is too slow. Instead, we require the user to reindex
    // const params = {field: fieldCid};
    // const script = 'ctx._source.remove(params.field)'
    cancelIndex(sigSet);
    return {reindexRequired: true};
}

async function onRemoveStorage(sigSet) {
    cancelIndex(sigSet);
    try {
        await elasticsearch.indices.delete({index: getIndexName(sigSet)});
    } catch (err) {
        if (err.body && err.body.error && err.body.error.type === 'index_not_found_exception') {
            log.verbose("Indexer", "Index does not exist during removal. Ignoring...");
        } else {
            throw err;
        }
    }

    return {};
}

async function onInsertRecords(sigSetWithSigMap, records) {
    // If currently reindex is in progress, then if it has been already deleted, records will be inserted from here
    // It has not been deleted, then it will reindex the new records as well

    const indexName = getIndexName(sigSetWithSigMap);
    const signalByCidMap = sigSetWithSigMap.signalByCidMap;

    let bulk = [];

    for (const record of records) {
        bulk.push({
            index: {
                _index: indexName,
                _type: '_doc',
                _id: record.id
            }
        });

        const esDoc = {};
        esDoc['id'] = record.id;
        for (const fieldCid in record.signals) {
            const fieldId = signalByCidMap[fieldCid].id;
            enforce(fieldId, `Unknown signal "${fieldCid}"`);

            esDoc[getFieldName(fieldId)] = record.signals[fieldCid];
        }

        bulk.push(esDoc);

        if (bulk.length >= insertBatchSize) {
            await elasticsearch.bulk({body: bulk});
            bulk = [];
        }
    }

    if (bulk.length > 0) {
        await elasticsearch.bulk({body: bulk});
    }

    emitter.emit(EventTypes.INSERT, sigSetWithSigMap.cid);
    return {};
}

async function onUpdateRecord(sigSetWithSigMap, existingRecordId, record) {
    const indexName = getIndexName(sigSetWithSigMap);

    const signalByCidMap = sigSetWithSigMap.signalByCidMap;

    const esDoc = {};
    for (const fieldCid in record.signals) {
        const fieldId = signalByCidMap[fieldCid].id;
        enforce(fieldId, `Unknown signal "${fieldCid}"`);

        esDoc[getFieldName(fieldId)] = record.signals[fieldCid];
    }

    try {
        await elasticsearch.delete({
            index: indexName,
            type: '_doc',
            id: existingRecordId
        });
    } catch (err) {
        if (err.status === 404) {
        } else {
            throw err;
        }
    }

    await elasticsearch.create({
        index: indexName,
        type: '_doc',
        id: record.id,
        body: esDoc
    });

    emitter.emit(EventTypes.UPDATE, sigSetWithSigMap.cid);
    return {};
}

async function onRemoveRecord(sigSet, recordId) {
    const indexName = getIndexName(sigSet);

    try {
        await elasticsearch.delete({
            index: indexName,
            type: '_doc',
            id: recordId
        });
    } catch (err) {
        if (err.status === 404) {
        } else {
            throw err;
        }
    }

    emitter.emit(EventTypes.REMOVE, sigSet.cid);
    return {};
}


// Cancel possible pending or running reindex of this signal set
function cancelIndex(sigSet) {
    indexerProcess.send({
        type: 'cancel-index',
        cid: sigSet.cid
    });
}

function index(sigSet, method, from) {
    indexerProcess.send({
        type: 'index',
        method,
        from,
        cid: sigSet.cid,
    });
}

module.exports.query = query;
module.exports.onCreateStorage = onCreateStorage;
module.exports.onExtendSchema = onExtendSchema;
module.exports.onRemoveField = onRemoveField;
module.exports.onRemoveStorage = onRemoveStorage;
module.exports.onInsertRecords = onInsertRecords;
module.exports.onUpdateRecord = onUpdateRecord;
module.exports.onRemoveRecord = onRemoveRecord;
module.exports.index = index;
module.exports.init = init;
module.exports.getDocsCount = getDocsCount;
module.exports.emitter = emitter;
