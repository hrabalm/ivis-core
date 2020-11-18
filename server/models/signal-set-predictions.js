'use strict';

const knex = require('../lib/knex');
const dtHelpers = require('../lib/dt-helpers');
const { JobState } = require("../../shared/jobs");
const { getBuiltinTask } = require("./builtin-tasks");
const jobs = require('./jobs');
//const { createTx } = require('./signals');
const { enforce } = require('../lib/helpers');

const predictionModels = {
    ARIMA: 'arima',
    // NAIVE: 'naive',
};

async function listDTAjax(context, sigSetId, params) {
    console.log(context);
    console.log(params);
    return await dtHelpers.ajaxList(
        params,
        builder => builder
            .from('predictions') 
            .where('sigSetId', sigSetId),
        ['predictions.sigSetId', 'predictions.name'],//['sigSetId', 'name'],
    )
}

async function createArimaModelTx(tx, context, sigSetId, params) {
    console.log(context);
    console.log(sigSetId);
    console.log(params);

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

    console.log(jobParams);

    const jobName = `predictions_arima_${signalSet.cid}_test`; // TODO (multiple models per signal set)
    const modelName = "TestModelName"; // TODO

    const job = {
        name: jobName,
        description: `Prediction for model '${modelName}'`,
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

    // run the job
    jobs.run(context, jobId).catch(error => log.error('signal-set-predictions', error));

    return jobId;
}

async function create(context, sigSetId, params) {
    //console.log(context);
    //console.log(params);
    return await knex.transaction(async tx => {
        return await createArimaModelTx(tx, context, sigSetId, params);
    });
}

module.exports.create = create;
module.exports.createTx = createArimaModelTx;
module.exports.listDTAjax = listDTAjax;