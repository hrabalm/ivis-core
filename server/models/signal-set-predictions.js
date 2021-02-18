'use strict';

const knex = require('../lib/knex');
const dtHelpers = require('../lib/dt-helpers');
const { JobState } = require("../../shared/jobs");
const { getBuiltinTask } = require("./builtin-tasks");
const jobs = require('./jobs');
const log = require('../lib/log');
//const { createTx } = require('./signals');
const { enforce, filterObject } = require('../lib/helpers');
const shares = require('./shares');

const predictionModels = {
    ARIMA: 'arima',
    // NAIVE: 'naive',
};

const allowedKeys = new Set(['name', 'type', 'params', 'namespace', 'sigSetId']);

function generateHistoryIndexName(signalSetName, modelName, modelType) {
    return [signalSetName, modelName, modelType, 'hist'].join('_');
}

function generateFutureIndexName(signalSetName, modelName, modelType) {
    return [signalSetName, modelName, modelType, 'futr'].join('_');
}

function generateJobName(signalSetName, modelName, modelType, postfix = '') {
    if (postfix == '')
        return [signalSetName, modelName, modelType, postfix].join('_');
    else
        return [signalSetName, modelName, modelType].join('_');
}

async function listDTAjax(context, sigSetId, params) {
    return await dtHelpers.ajaxList(
        params,
        builder => builder
            .from('predictions')
            .where('sigSetId', sigSetId),
        ['predictions.id', 'predictions.sigSetId', 'predictions.name', 'predictions.type'],
    )
}

async function createPrediction(context, prediction) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'signalSet', prediction.sigSetId, 'createPrediction');

        const filteredPrediction = filterObject(prediction, allowedKeys);
        const id = await tx('predictions').insert(filteredPrediction);

        await shares.rebuildPermissionsTx(tx, {
            entityTypeId: 'prediction',
            entityId: id
        });

        return id;
    });
}

async function getParamsById(context, id) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'prediction', id, 'view');
        const model = await tx('predictions').select(['params']).where('id', id).first();
        return JSON.parse(model.params);
    });
}

async function updateParamsById(context, id, params) {
    await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'prediction', id, 'edit');
        await tx('predictions').where('id', id).update('params', JSON.stringify(params));
    });
}

async function createArimaModelTx(tx, context, sigSetId, params) {
    const ts = params.ts;

    const signalSet = await tx('signal_sets').where('id', sigSetId).first();
    enforce(signalSet, `Signal set ${sigSetId} not found`);

    const arimaTask = await getBuiltinTask('ARIMA');
    enforce(arimaTask, `ARIMA builtin task not found`);

    const tsExists = tx('signals').where({ set: sigSetId, cid: ts }).first();
    enforce(tsExists, `Timestamp signal not found in ${sigSetId}`);

    const jobParams_org = {
        signalSet: signalSet.cid,
        sigSet: signalSet.cid,
        ts: ts,
    };

    const jobParams = { ...params, ...jobParams_org };

    //const jobName = `predictions_arima_${signalSet.cid}_${params.name}`; // TODO (multiple models per signal set)
    const jobName = generateJobName(signalSet.cid, params.name, predictionModels.ARIMA);
    const modelName = params.name;
    const namespace = signalSet.namespace;

    const job = {
        name: jobName,
        description: `ARIMA for '${signalSet.cid}', '${modelName}'`,
        namespace: namespace,
        task: arimaTask.id,
        state: JobState.ENABLED,
        params: jobParams,
        signal_set_triggers: [sigSetId],
        trigger: null,
        min_gap: null,
        delay: null,
    }

    const jobId = await jobs.create(context, job);

    // TODO: Register job-model pair
    const prediction = {
        sigSetId: sigSetId,
        name: params.name,
        params: '{}',
        type: predictionModels.ARIMA,
        namespace: namespace,
    }
    const modelId = await createPrediction(context, prediction);
    let modelParams = await getParamsById(context, modelId);
    modelParams.jobId = jobId;
    await updateParamsById(context, modelId, modelParams);

    // run the job
    jobs.run(context, jobId).catch(error => log.error('signal-set-predictions', error));

    return jobId;
}

async function createArimaModel(context, sigSetId, params) {
    return await knex.transaction(async tx => {
        return await createArimaModelTx(tx, context, sigSetId, params);
    });
}

module.exports.create = createArimaModel;
module.exports.createTx = createArimaModelTx;
module.exports.listDTAjax = listDTAjax;