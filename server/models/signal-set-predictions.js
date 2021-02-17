'use strict';

const knex = require('../lib/knex');
const dtHelpers = require('../lib/dt-helpers');
const { JobState } = require("../../shared/jobs");
const { getBuiltinTask } = require("./builtin-tasks");
const jobs = require('./jobs');
const log = require('../lib/log');
//const { createTx } = require('./signals');
const { enforce } = require('../lib/helpers');

const predictionModels = {
    ARIMA: 'arima',
    // NAIVE: 'naive',
};

async function listDTAjax(context, sigSetId, params) {
    return await dtHelpers.ajaxList(
        params,
        builder => builder
            .from('predictions')
            .where('sigSetId', sigSetId),
        ['predictions.id', 'predictions.sigSetId', 'predictions.name', 'predictions.type'],//['sigSetId', 'name'],
    )
}

async function createPrediction(sigSetId, name, type) {
    let params = JSON.stringify({
    });
    return await knex.transaction(async tx => {
        const prediction = {
            sigSetId: sigSetId,
            name: name,
            params: params,
            type: type,
        }
        const id = await tx('predictions').insert(prediction);

        return id;
    });
}

async function getParamsById(context, id) {
    return await knex.transaction(async tx => {
        // TODO: enforce permissions
        const model = await tx('predictions').select(['params']).where('id', id).first();
        return JSON.parse(model.params);
    });
}

async function updateParamsById(context, id, params) {
    await knex.transaction(async tx => {
        // TODO: enforce permissions
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

    const jobName = `predictions_arima_${signalSet.cid}_${params.name}`; // TODO (multiple models per signal set)
    const modelName = params.name;

    const job = {
        name: jobName,
        description: `ARIMA for '${signalSet.cid}', '${modelName}'`,
        namespace: signalSet.namespace,
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
    const modelId = await createPrediction(sigSetId, params.name, predictionModels.ARIMA);
    let modelParams = await getParamsById(context, modelId);
    modelParams.jobId = jobId;
    await updateParamsById(context, modelId, modelParams);

    // run the job
    jobs.run(context, jobId).catch(error => log.error('signal-set-predictions', error));

    return jobId;
}

async function create(context, sigSetId, params) {
    return await knex.transaction(async tx => {
        return await createArimaModelTx(tx, context, sigSetId, params);
    });
}

module.exports.create = create;
module.exports.createTx = createArimaModelTx;
module.exports.listDTAjax = listDTAjax;