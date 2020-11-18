'use strict';

import React, { Component } from "react";
import { tableRestActionDialogInit, tableRestActionDialogRender } from "../../lib/modals";
import { withComponentMixins } from "../../lib/decorator-helpers";
import { withTranslation } from "../../lib/i18n";
import { Panel } from "../../lib/panel";
import { Table } from "../../lib/table";
import { Toolbar, LinkButton } from "../../lib/page";

@withComponentMixins([
    withTranslation,
    //withErrorHandling,
    //withPageHelpers,
    //requiresAuthenticatedUser
])
export default class PredictionsList extends Component {
    constructor(props) {
        super(props);

        this.state = {};

        tableRestActionDialogInit(this);
    }

    render() {
        const t = this.props.t;
        const sigSetId = this.props.signalSet.id;
        const columns = [
            { data: 0, title: t('sigSetId'), render: data => `${data}` },
            { data: 1, title: t('Name'), render: data => `${data}` },
        ]
        return (
            <Panel title={t('Predictions')}>
                {tableRestActionDialogRender(this)}
                <Toolbar>
                    <LinkButton to={`/settings/signal-sets/${sigSetId}/predictions/create-arima`} className="btn-primary"
                        icon="plus"
                        label={t('Add ARIMA model')} />
                </Toolbar>

                <Table ref={node => this.table = node} withHeader
                    dataUrl={`rest/signal-set-predictions-table/${sigSetId}`} columns={columns} />
            </Panel>
        )
    }
}