'use strict';

const fs = require('fs');
const { TaskSource, BuildState, TaskType, subtypesByType} = require("../../../shared/tasks");

const taskCode = fs.readFileSync('models/arima/arima-task.py', 'utf-8');
const taskParams = require('./arima-params.json');

const arimaTask = {
    id: 'arima',
    name: 'ARIMA',
    description: 'ARIMA task',
    type: TaskType.PYTHON,
    settings: {
        params: taskParams,
        code: taskCode,
        //subtype: subtypesByType[TaskType.PYTHON].ARIMA,
        subtype: "arima", // TODO: Fix
    },
};

module.exports = {
    arimaTask
}
