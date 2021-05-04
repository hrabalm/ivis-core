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
const predictions = require('./signal-set-predictions');
const { PredictionTypes, OutputSignalTypes } = require('../../shared/predictions');

function _generateJobName(signalSetName, modelName, modelType, postfix = '') {
    if (postfix == '')
        return [signalSetName, modelName, modelType, postfix].join('_');
    else
        return [signalSetName, modelName, modelType].join('_');
}

async function createJob() {

}

async function createArimaModelTx(tx, context, sigSetId, params) {
    console.log(`createArimaModelTx(context=${JSON.stringify(context)})`);
    console.log(`params = ${params}`);

    const ts = params.ts;

    const signalSet = await tx('signal_sets').where('id', sigSetId).first();
    enforce(signalSet, `Signal set ${sigSetId} not found`);

    const arimaTask = await getBuiltinTask('ARIMA');
    enforce(arimaTask, `ARIMA builtin task not found`);

    const tsExists = await tx('signals').where({ set: sigSetId, cid: ts }).first();
    enforce(tsExists, `Timestamp signal not found in ${sigSetId}`);

    const jobName = _generateJobName(signalSet.cid, params.name, PredictionTypes.ARIMA);
    const modelName = params.name;
    const namespace = signalSet.namespace;

    const ahead_count = parseInt(params.futurePredictions); // TODO: Rename

    const jobParams_org = {
        signalSet: signalSet.cid,
        sigSet: signalSet.cid,
        ts: ts,
    };

    const jobParams = { ...params, ...jobParams_org };

    const job = {
        name: jobName,
        description: `ARIMA for '${signalSet.cid}', '${modelName}'`,
        namespace: namespace,
        task: arimaTask.id,
        state: JobState.ENABLED,
        params: jobParams,
        signal_sets_triggers: [sigSetId],
        trigger: null,
        min_gap: null,
        delay: null,
    }

    let prediction = {
        name: params.name,
        type: PredictionTypes.ARIMA,
        set: sigSetId,
        ahead_count: ahead_count,  // generally, future should be equal to ahead but for
        future_count: ahead_count, // very high values you can consider future > ahead
        namespace: namespace
    };

    const outSignals = [
        {
            cid: "predicted_value",
            name: "Predicted Value",
            namespace: 1,
            type: "double",
            indexed: false,
            weight_list: 0
        }
    ]

    const modelId = await predictions.registerPredictionModelTx(tx, context, prediction, outSignals);

    const outputConfig = await predictions.getOutputConfigTx(tx, context, modelId);
    job.params.output_config = outputConfig;

    const jobId = await jobs.createTx(tx, context, job);
    await predictions.registerPredictionModelJobTx(tx, context, modelId, jobId);

    console.log(`job: ${JSON.stringify(job)}`);

    //await predictions.getOutputConfigTx(tx, context, modelId);

    // run the job
    //jobs.run(context, jobId).catch(error => log.error('signal-set-predictions', error));

    // update state to active?

    return { prediction, jobId };
}

async function createArimaModel(context, sigSetId, params) {
    return await knex.transaction(async tx => {
        return await createArimaModelTx(tx, context, sigSetId, params);
    });
}

async function createAndStart(context, sigSetId, params) {
    const { prediction, jobId } = await knex.transaction(async tx => {
        return await createArimaModelTx(tx, context, sigSetId, params);
    });

    // const { modelId, jobId }
    const modelId = prediction.id;
    const setId = prediction.set;

    const outputConfig = await predictions.getOutputConfig(context, modelId);
    console.log(`outputConfig = ${JSON.stringify(outputConfig)}`);

    // run the job
    jobs.run(context, jobId).catch(error => log.error('predictions-arima', error));
}

//module.exports.create = createArimaModel;
module.exports.create = createAndStart;
module.exports.createTx = createArimaModelTx;