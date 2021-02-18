'use strict';

import React, { Component } from "react";
import { tableAddDeleteButton, tableRestActionDialogInit, tableRestActionDialogRender } from "../../lib/modals";
import { withComponentMixins } from "../../lib/decorator-helpers";
import { withTranslation } from "../../lib/i18n";
import { Panel } from "../../lib/panel";
import { Table } from "../../lib/table";
import { Toolbar, LinkButton, requiresAuthenticatedUser, withPageHelpers } from "../../lib/page";
import { withAsyncErrorHandler, withErrorHandling } from "../../lib/error-handling";
import {
    Form,
    withForm,
    withFormErrorHandlers,
    TableSelect,
    TableSelectMode,
    InputField,
} from "../../lib/form";
//import { filter } from "lodash";
import { LineChart } from "../../ivis/LineChart";
import { TimeContext } from "../../ivis/TimeContext";
import { TimeRangeSelector } from "../../ivis/TimeRangeSelector";
import {
    IntervalSpec,
    TimeInterval
} from "../../ivis/TimeInterval";
import moment from "moment";
import axios, { HTTPMethod } from '../../lib/axios';
import { getUrl } from "../../lib/urls";
import { rgb } from "d3-color";

class PredictionsGraph extends Component {
    constructor(props) {
        super(props);
        this.state = {
            //config: {},
        };
    }

    async getModel(modelId) {
        let x = await axios.get(getUrl(`rest/predictions/${modelId}`));
        console.log(x.data);
        return await x.data;
    }

    async fetchData() {
        const models = await this.props.models.map(this.getModel);

        return await models;
    }

    async getConfig() {
        const colors = ["rgb(255,0,0)", "rgb(0,255,0)", "rgb(0,0,255)"]
        let config = {
            signalSets: [
                {
                    cid: this.props.sigSetCid,
                    signals: [
                        {
                            label: "original data",
                            color: "#220000",
                            cid: this.props.signalCid,
                            enabled: true,
                        }
                    ],
                    tsSigCid: this.props.tsCid,
                },
            ]
        };

        let models = await this.fetchData();
        // TODO: Check all models share the same signal
        // TODO: Get models' signal sets
        console.log("models.length");

        console.log(models.length);
        for (let i = 0; i < models.length; i++) {
            let model = await models[i];
            console.log("before:");
            console.log(config);
            console.log("model:");
            console.log(model);
            config.signalSets.push({
                cid: model.futr_cid, // TODO
                signals: [
                    {
                        label: model.name + "_futr", // TODO
                        color: colors[i], // TODO
                        cid: "predicted_value",
                        enabled: true,
                    }
                ],
                tsSigCid: 'ts',
            });
            config.signalSets.push({
                cid: model.hist_cid, // TODO
                signals: [
                    {
                        label: model.name + "_hist", // TODO
                        color: colors[i], // TODO
                        cid: "predicted_value",
                        enabled: true,
                    }
                ],
                tsSigCid: 'ts',
            });
            console.log("after:");
            console.log(config);
        }

        // TODO: Get common first ts - for now hardcoded
        return config;
    }

    componentDidMount() {
        this.getConfig().then(config => this.setState({ config: config, ready: true }));
        this.getConfig().then(config => {
            console.log("finished?");
            console.log(config);
        });
    }

    componentDidUpdate(prevProps) {
        if (this.props.models !== prevProps.models) {
            this.getConfig().then(config => this.setState({ config: config }));
        }
    }

    render() {
        const config = this.state.config;

        return (
            <TimeContext
                initialIntervalSpec={new IntervalSpec('now-100y', 'now+5y', null, moment.duration(1, 'd'))}
            >
                <TimeRangeSelector />
                {config && <LineChart
                    config={config}
                //height={500}
                />}
            </TimeContext>
        );
    }
}

function filterBySignal(element, index, signal) {
    console.log(signal);
    if (element[index] == signal)
        return true;
    return false;
}

@withComponentMixins([
    withTranslation,
    withForm,
    withErrorHandling,
    withPageHelpers,
    requiresAuthenticatedUser
])
export default class PredictionsCompare extends Component {
    constructor(props) {
        super(props);

        this.state = {};

        this.initForm({
            onChange: {
                signal: :: this.onSignalChange,
                models: :: this.onModelsChange,
            }
        });
        tableRestActionDialogInit(this);
    }

    componentDidMount() {
        if (this.props.entity) {
            this.getFormValuesFromEntity(this.props.entity);
        } else {
            this.populateFormValues({
                name: '',
            });
        }
    }

    onSignalChange(state, key, oldValue, newValue) {
        if (oldValue != newValue) {
            //this.setState({ signal: newValue });
            state.signal = newValue;
        }
    }

    onModelsChange(state, key, oldValue, newValue) {
        if (oldValue != newValue) {
            //this.setState({ models: newValue });
            //console.log("state");
            //console.log(this.state);
            state.models = newValue;
        }
    }

    render() {
        const t = this.props.t;
        const sigSetId = this.props.signalSet.id;
        const sigSetCid = this.props.signalSet.cid;
        //console.log(this.props.signalSet);
        const columns = [
            { data: 1, title: t('Id') },
            { data: 2, title: t('Name') },
            { data: 3, title: t('Description') },
            //{ data: 4, title: t('Type'), render: data => signalTypes[data] },
        ];

        const modelsColumns = [
            { data: 0, title: t('Id') },
            { data: 2, title: t('Name') },
            { data: 3, title: t('Description') },
            { data: 4, title: t('Signal') },
            //{ data: 4, title: t('Type'), render: data => signalTypes[data] },
        ];
        return (
            <Panel title={t('Compare models')}>
                {tableRestActionDialogRender(this)}
                <Toolbar>
                    {/*<LinkButton to={`/settings/signal-sets/${sigSetId}/predictions/create-arima`} className="btn-primary"
                        icon="plus"
        label={t('Add ARIMA model')} />*/}
                </Toolbar>

                {/*<Table ref={node => this.table = node} withHeader
                    dataUrl={`rest/signal-set-predictions-table/${sigSetId}`} columns={columns} />*/}
                {/*
                  * 1. Select signal
                  * 2. Select models using this signal
                  * 3. Select appropriate timespan
                  * 4. Show graph of original data and these models
                  * 5. Calculate their performance on the timespan
                */}
                <Form stateOwner={this} >
                    <TableSelect
                        key="signal"
                        id="signal"
                        label={t("Target signal")}
                        withHeader
                        dropdown
                        selectMode={TableSelectMode.SINGLE}
                        selectionLabelIndex={2}
                        selectionKeyIndex={1}
                        dataUrl={`rest/signals-table-by-cid/${this.props.signalSet.cid}`}
                        columns={columns}
                    />

                    {this.state.signal && <TableSelect
                        /* We change the key here so that the table refreshes */
                        key={"models" + this.state.signal}
                        id="models"
                        label={t("Models to compare")}
                        withHeader
                        dropdown
                        selectMode={TableSelectMode.MULTI}
                        selectionLabelIndex={2}
                        selectionKeyIndex={0}
                        dataUrl={`rest/signal-set-predictions-table/${sigSetId}`}
                        dataFilter={x => x.filter(y => filterBySignal(y, 4, this.state.signal))}
                        columns={modelsColumns}
                    />}

                </Form>
                { this.state.models && <PredictionsGraph
                    //sigSetId={sigSetId}
                    key="abcd"
                    sigSetCid={sigSetCid}
                    tsCid="ts"
                    signalCid={this.state.signal}
                    models={this.state.models}
                />}
            </Panel>
        );
    }
}