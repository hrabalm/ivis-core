'use strict';

import React from "react";
import {ACEEditor, CheckBox, DateTimePicker, InputField} from "../../lib/form";
import moment from "moment";

const { SignalType, SignalSource } = require('../../../../shared/signals');

export default class FieldTypes {
    constructor(t, signalsVisibleForEdit) {
        this.signalsVisibleForEdit = signalsVisibleForEdit.filter(sig => sig.source === SignalSource.RAW);

        this.fieldTypes = {};

        this.fieldTypes[SignalType.INTEGER] = this.fieldTypes[SignalType.LONG] = {
            localValidate: (sigSpec, state, formId) => {
                const val = state.getIn([formId, 'value']);

                if (val !== '' && !Number.isInteger(Number.parseFloat(val))) {
                    state.setIn([formId, 'error'], t('Please enter a valid integer number'));
                }
            },
            render: (sigSpec, self, formId) => <InputField key={sigSpec.cid} id={formId} label={sigSpec.name}/>,
            getSignal: (sigSpec, data, formId) => data[formId] === '' ? null : Number.parseInt(data[formId]),
            populateFields: (sigSpec, data, value, formId) => data[formId] = value === null ? '' : value.toString()
        };

        this.fieldTypes[SignalType.FLOAT] = this.fieldTypes[SignalType.DOUBLE] = {
            localValidate: (sigSpec, state, formId) => {
                const val = state.getIn([formId, 'value']);

                if (val !== '' && Number.isNaN(Number.parseFloat(val))) {
                    state.setIn([formId, 'error'], t('Please enter a valid floating point number'));
                }
            },
            render: (sigSpec, self, formId) => <InputField key={sigSpec.cid} id={formId} label={sigSpec.name}/>,
            getSignal: (sigSpec, data, formId) => data[formId] === '' ? null : Number.parseFloat(data[formId]),
            populateFields: (sigSpec, data, value, formId) => data[formId] = value === null ? '' : value.toString()
        };

        this.fieldTypes[SignalType.BOOLEAN] = {
            localValidate: (sigSpec, state, formId) => { },
            render: (sigSpec, self, formId) => <CheckBox key={sigSpec.cid} id={formId} label={sigSpec.name}/>,
            getSignal: (sigSpec, data, formId) => data[formId],
            populateFields: (sigSpec, data, value, formId) => data[formId] = value
        };

        this.fieldTypes[SignalType.KEYWORD] = this.fieldTypes[SignalType.TEXT] = {
            localValidate: (sigSpec, state, formId) => { },
            render: (sigSpec, self, formId) => <InputField key={sigSpec.cid} id={formId} label={sigSpec.name}/>,
            getSignal: (sigSpec, data, formId) => data[formId] === '' ? null : data[formId],
            populateFields: (sigSpec, data, value, formId) => data[formId] = value === null ? '' : value
        };


        const parseDate = str => {
            const date = moment(str, 'YYYY-MM-DD HH:mm:ss', true);
            if (date && date.isValid()) {
                return date.toDate();
            } else {
                return null;
            }
        };

        this.fieldTypes[SignalType.DATE_TIME] = {
            localValidate: (sigSpec, state, formId) => {
                const val = state.getIn([formId, 'value']);
                const date = parseDate(val);
                if (val !== '' && !date) {
                    state.setIn([formId, 'error'], t('Please enter a valid date and time in format YYYY-MM-DD hh:mm:ss.SSS'));
                }
            },
            render: (sigSpec, self, formId) =>
                <DateTimePicker
                    key={sigSpec.cid}
                    id={formId}
                    label={sigSpec.name}
                    formatDate={date => moment(date).format('YYYY-MM-DD') + ' 00:00:00'}
                    parseDate={str => parseDate(str)}
                />
            ,
            getSignal: (sigSpec, data, formId) => data[formId] === '' ? null : parseDate(data[formId]),
            populateFields: (sigSpec, data, value, formId) => data[formId] = value === null ? moment().format('YYYY-MM-DD HH:mm:ss') : moment(value).format('YYYY-MM-DD HH:mm:ss')
        };

        this.fieldTypes[SignalType.JSON] = {
            localValidate: (sigSpec, state, formId) => {
                const val = state.getIn([formId, 'value']);

                try {
                    const o = JSON.parse(val);
                    if (typeof o !== "object" || Array.isArray(o))
                        throw SyntaxError("Only JSON objects are allowed.");
                }
                catch (e) {
                    if (e instanceof SyntaxError) {
                        state.setIn([formId, 'error'], t('Please enter a valid JSON.') + " (" + e.message + ")");
                    }
                    else throw e;
                }
            },
            render: (sigSpec, self, formId) => <ACEEditor key={sigSpec.cid} id={formId} label={sigSpec.name} mode={"json"} height={100} />,
            getSignal: (sigSpec, data, formId) => data[formId] === '' ? null : JSON.parse(data[formId]),
            populateFields: (sigSpec, data, value, formId) => data[formId] = value === null ? '' : JSON.stringify(value)
        };
    }


    localValidate(state) {
        for (const sigSpec of this.signalsVisibleForEdit) {
            this.fieldTypes[sigSpec.type].localValidate(sigSpec, state, this.getFormId(sigSpec.cid));
        }
    }

    render(self) {
        const rows = [];

        for (const sigSpec of this.signalsVisibleForEdit) {
            rows.push(this.fieldTypes[sigSpec.type].render(sigSpec, self, this.getFormId(sigSpec.cid)));
        }

        return rows;
    }

    getSignals(data) {
        const signals = {};

        for (const sigSpec of this.signalsVisibleForEdit) {
            signals[sigSpec.cid] = this.fieldTypes[sigSpec.type].getSignal(sigSpec, data, this.getFormId(sigSpec.cid));
        }

        return signals;
    }

    populateFields(data, signals) {
        for (const sigSpec of this.signalsVisibleForEdit) {
            this.fieldTypes[sigSpec.type].populateFields(sigSpec, data, signals && sigSpec.cid in signals ? signals[sigSpec.cid] : null, this.getFormId(sigSpec.cid));
        }
    }


    getPrefix() {
        return this.getFormId('');
    }

    getAllFormIds() {
        return this.signalsVisibleForEdit.map(x => this.getFormId(x.cid));
    }


    // ------------------------------------------------------------------
    // Private methods

    getFormId(fieldId) {
        return 'field_' + fieldId;
    }
}
