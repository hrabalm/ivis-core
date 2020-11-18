'use strict';

import React, { Component } from "react";
import { DeleteModalDialog } from "../../lib/modals";
import { Panel } from "../../lib/panel";
import { tableRestActionDialogInit, tableRestActionDialogRender } from "../../lib/modals";
import { LinkButton, requiresAuthenticatedUser, withPageHelpers } from "../../lib/page";
import { withComponentMixins } from "../../lib/decorator-helpers";
import { withTranslation } from "../../lib/i18n";
import axios, { HTTPMethod } from '../../lib/axios';
import { getUrl } from "../../lib/urls";
import {
    Button,
    ButtonRow,
    DateTimePicker,
    filterData,
    Form,
    FormSendMethod,
    InputField,
    TableSelect,
    TableSelectMode,
    withForm,
    withFormErrorHandlers
} from "../../lib/form";

@withComponentMixins([
    withTranslation,
    //withForm,
    //withErrorHandling,
    //withPageHelpers,
    requiresAuthenticatedUser
])
export default class CUD extends Component {
    constructor(props) {
        super(props);

        this.state = {};
    }

    createTestModel() {
        const sendMethod = FormSendMethod.POST;
        const url = `rest/signal-sets/${this.props.signalSet.id}/predictions/arima`;

        //const submitResult = this.validateAndSendFormValuesToURL(sendMethod, url);

        const data = {
            context: {
                
            },
            params: {
                signalSetId: this.props.signalSet.id,
                sigSetCid: this.props.signalSet.id,
            },
            body: {

            },
        };

        const params = {
            ts: 'ts',

            source: 'value',
            seasonality: false,
        }

        const response = axios.post(getUrl(url), params);

        console.log(response);
    }

    render() {
        const t = this.props.t;
        return (
            <Panel title="Add ARIMA model">
                <ButtonRow>
                    <Button type="submit" className="btn-primary" label="Create Test Model" onClickAsync={x => this.createTestModel()}/>
                </ButtonRow>
            </Panel>
        );
    }
}