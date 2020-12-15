'use strict';
const em = require('./extension-manager');

const fork = require('child_process').fork;

const path = require('path');
const log = require('./log');
const esClient = require('./elasticsearch');
const getFilesDir = require('../models/files').getEntityFilesDir;
const fs = require('fs-extra-promise');
const config = require("./config");

const knex = require('./knex');
const {RunStatus, HandlerMsgType} = require('../../shared/jobs');
const {BuildState, getTransitionStates} = require('../../shared/tasks');
const storeBuiltinTasks = require('../models/builtin-tasks').storeBuiltinTasks;

const {emitter: esEmitter, EventTypes: EsEventTypes} = require('./elasticsearch-events');
const {emitter: taskEmitter} = require('./task-events');
const {emitter: filesEmitter, EventTypes: FilesEventTypes} = require('./files-events');

const handlerExec = em.get('task-handler.exec', path.join(__dirname, '..', 'services', 'task-handler.js'));

const LOG_ID = 'Task-handler-lib';
const INDEX_JOBS = 'jobs';
const TYPE_JOBS = '_doc';
const STATE_FIELD = 'state';

const tasksDir = path.join(__dirname, '..', 'files', 'task-content');


/**
 * Returns path to the directory containing all task related files.
 * @param id the primary key of the task
 * @returns {string}
 */
function getTaskDir(id) {
    return path.join(tasksDir, id.toString());
}

/**
 * Returns path to the directory containing all run related files.
 * @param id
 * @returns {string}
 */
function getTaskBuildOutputDir(id) {
    return path.join(getTaskDir(id), 'dist')
}

let handlerProcess;

async function init() {
    log.info(LOG_ID, 'Spawning job handler process');


    await initIndices();

    try {
        await cleanRuns();
    } catch (err) {
        log.error(LOG_ID, err);
    }

    try {
        await cleanBuilds();
    } catch (err) {
        log.error(LOG_ID, err);
    }

    try {
        await initBuiltin();
    } catch (err) {
        log.error(LOG_ID, err);
    }

    const options = {
        cwd: path.join(__dirname, '..'),
        env: {NODE_ENV: process.env.NODE_ENV}

    };
    if (process.env.NODE_ENV && process.env.NODE_ENV === 'development') {
        options.silent = false;
        options.execArgv = ['--inspect=0'];
    }

    handlerProcess = fork(handlerExec, [], options);

    handlerProcess.on('close', (code, signal) => {
        log.info(LOG_ID, `Job-handler process exited with code ${code} signal ${signal}`);
    });

    handlerProcess.on('message', (msg) => {
        taskEmitter.emit(msg.type, msg.data)
    });

    esEmitter
        .on(EsEventTypes.INSERT, reindexOccurred)
        .on(EsEventTypes.INDEX, reindexOccurred)

    filesEmitter
        .on(FilesEventTypes.CHANGE, onFilesUpload)
        .on(FilesEventTypes.REMOVE_ALL, onRemoveAllFiles)
        .on(FilesEventTypes.REMOVE, onRemoveFile);

    const logRetention = config.tasks.runLogRetentionTime;
    if (logRetention && logRetention !== 0) {
        checkLogRetention(logRetention);
    }
}

function checkLogRetention(logRetention) {
    knex('job_runs')
        .whereIn('status', [RunStatus.FAILED, RunStatus.SUCCESS])
        .where('finished_at', '<', knex.raw('now() - INTERVAL ? DAY', logRetention))
        .del()
        .catch(err => log.error(LOG_ID, err));

    setTimeout(checkLogRetention, logRetention * 24 * 60 * 60 * 1000, logRetention);
}

function onFilesUpload(type, subtype, entityId, files) {
    if (type === 'task') {
        setImmediate(async () => {
            const dir = getFilesDir(type, subtype, entityId);
            const filesDir = path.join(getTaskDir(entityId), 'files');
            for (const file of files) {
                await fs.copyAsync(path.join(dir, file.name), path.join(filesDir, file.originalName), {});
            }
        });
    }
}

function onRemoveFile(type, subtype, entityId, file) {
    if (type === 'task') {
        setImmediate(async () => {
            const filePath = path.join(getTaskDir(entityId), 'files', file.originalName);
            await fs.removeAsync(filePath);
        })
    }
}

function onRemoveAllFiles(type, subtype, entityId) {
    if (type === 'task') {
        setImmediate(async () => {
            const filesDir = path.join(getTaskDir(entityId), 'files');
            await fs.emptyDirAsync(filesDir);
        })
    }
}

/**
 * Create job index if it doesn't exists and set correct mapping for job config.
 * Mapping disables parsing for config field as job can include any json and it would clash with es types implementation
 * should two stored states differ
 */
async function initIndices() {
    let reachable = true;
    try {
        await esClient.ping();

    } catch (err) {
        log.error(LOG_ID, 'Creating index for job in elasticsearch failed, ES unreachable');
        reachable = false;
    }
    if (reachable) {
        const exists = await esClient.indices.exists({index: INDEX_JOBS});
        if (!exists) {
            let settings = {
                "mappings": {
                    [TYPE_JOBS]: {
                        "properties": {
                            [STATE_FIELD]: {
                                "type": "object",
                                "enabled": false
                            }
                        }
                    }
                }
            };
            // create index
            await esClient.indices.create({index: INDEX_JOBS, body: settings});
        }
    }

}

async function initBuiltin() {
    await storeBuiltinTasks();
}

/**
 * Prevents run DB table from being in inconsistent state on a new start.
 * @returns {Promise<void>}
 */
async function cleanRuns() {
    const runs = await knex('job_runs').whereIn('status', [RunStatus.INITIALIZATION, RunStatus.SCHEDULED, RunStatus.RUNNING]);
    if (runs) {
        for (const run of runs) {
            try {
                await knex('job_runs').where('id', run.id).update({
                    status: RunStatus.FAILED,
                    output: 'Cancelled upon start'
                })
            } catch (err) {
                log.error(LOG_ID, `Failed to clear run with id ${run.id}: ${err.stack}`);
            }
        }
    }
}

/**
 * Prevents build state in tasks table from being in inconsistent state on a new start.
 * @returns {Promise<void>}
 */
async function cleanBuilds() {
    const tasks = await knex('tasks').whereIn('build_state', getTransitionStates());
    if (tasks) {
        for (const task of tasks) {
            try {
                await knex('tasks').where('id', task.id).update({
                    build_state: (task.build_state === BuildState.INITIALIZING) ? BuildState.UNINITIALIZED : BuildState.FAILED,
                    build_output: JSON.stringify({errors: ['Cancelled upon start']})
                })
            } catch (err) {
                log.error(LOG_ID, `Failed to clear builds for job with id ${task.id}:  ${err.stack}`);
            }
        }
    }
}

async function reindexOccurred(cid) {
    const spec = {};
    spec.cid = cid;

    handlerProcess.send({
        type: HandlerMsgType.SIGNAL_TRIGGER,
        spec: spec
    });
}

function scheduleBuild(taskId, code, destDir) {
    const spec = {};
    spec.taskId = taskId;
    spec.code = code;
    spec.destDir = destDir;

    handlerProcess.send({
        type: HandlerMsgType.BUILD,
        spec: spec

    });
}

function scheduleInit(taskId, code, destDir) {
    const spec = {};
    spec.taskId = taskId;
    spec.code = code;
    spec.destDir = destDir;

    handlerProcess.send({
        type: HandlerMsgType.INIT,
        spec: spec
    });


}

async function scheduleRun(jobId, taskDir, runId) {
    const spec = {};
    spec.jobId = jobId;
    spec.taskDir = taskDir;

    if (runId) {
        spec.runId = runId
    }

    handlerProcess.send({
        type: HandlerMsgType.RUN,
        spec: spec
    });
}

async function scheduleRunStop(jobId, runId) {
    const spec = {};
    spec.jobId = jobId;
    spec.runId = runId;

    handlerProcess.send({
        type: HandlerMsgType.STOP,
        spec: spec
    });
}

function scheduleTaskDelete(taskId, type) {
    const spec = {};
    spec.taskId = taskId;
    spec.type = type;

    handlerProcess.send({
        type: HandlerMsgType.DELETE_TASK,
        spec: spec
    });
}

function scheduleJobDelete(jobId) {
    const spec = {};
    spec.jobId = jobId;

    handlerProcess.send({
        type: HandlerMsgType.DELETE_JOB,
        spec: spec
    });
}

module.exports.init = init;
module.exports.scheduleBuild = scheduleBuild;
module.exports.scheduleRun = scheduleRun;
module.exports.scheduleRunStop = scheduleRunStop;
module.exports.scheduleTaskDelete = scheduleTaskDelete;
module.exports.scheduleJobDelete = scheduleJobDelete;
module.exports.scheduleInit = scheduleInit;
module.exports.esConstants = {INDEX_JOBS, TYPE_JOBS, STATE_FIELD};
module.exports.getTaskDir = getTaskDir;
module.exports.getTaskBuildOutputDir = getTaskBuildOutputDir;
