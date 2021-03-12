"use strict";
const em = require('./extension-manager');
const {getFieldName} = require('./indexers/elasticsearch-common');

const allowedKeysCreate = new Set(['cid', 'name', 'description', 'type', 'source', 'set', 'indexed', 'settings', 'namespace', 'weight_list', 'weight_edit', ...em.get('models.signals.extraKeys', [])]);
const allowedKeysUpdate = new Set(['cid', 'name', 'description', 'type', 'source', 'indexed', 'settings', 'namespace', 'weight_list', 'weight_edit', ...em.get('models.signals.extraKeys', [])]);

function getSignalEntitySpec(signal) {
    return {
        ...signal,
        field: getFieldName(signal.id),
    };
}

module.exports = {
    allowedKeysCreate,
    allowedKeysUpdate,
    getSignalEntitySpec
};
