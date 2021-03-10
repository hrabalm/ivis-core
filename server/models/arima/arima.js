'use strict';

const fs = require('fs');
const path = require('path');
const { TaskSource, BuildState, TaskType, subtypesByType} = require("../../../shared/tasks");

const taskPath = path.join(__dirname, 'arima-task.py'); // relative path
const taskCode = fs.readFileSync(taskPath, 'utf-8');
const taskParams = require('./arima-params.json');

const arimaTask = {
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
