'use strict';

import React, { Component } from "react";
import { tableAddDeleteButton, tableRestActionDialogInit, tableRestActionDialogRender } from "../../lib/modals";
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
            { data: 0, title: t('id(debug)'), render: data => `${data}` },
            { data: 1, title: t('sigSetId(debug)'), render: data => `${data}` },
            {
                data: 2,
                title: t('Name'),
                //render: data => `${data}`
                actions: data => {
                    const modelId = data[0];
                    const sigSetId = data[1];
                    const label = data[2]; // Model name
                    const type = data[3]; // Model type

                    // TODO: check permissions (see signal-sets/List.js)
                    return [
                        {
                            label,
                            link: `/settings/signal-sets/${sigSetId}/predictions/${type}/${modelId}`
                        }
                    ];
                }
            },
            { data: 3, title: t('type(debug)'), render: data => `${data}` },
            { data: 4, title: t('Predicted Signal'), render: data => `${data}` },
            {
                actions: data => {
                    const actions = [];

                    // TODO: check delete permissions and other error handling
                    // TODO: Delete button
                    // tableAddDeleteButton(actions, this, perms)

                    return actions;
            }}
        ]
        return (
            <Panel title={t('Predictions')}>
                {tableRestActionDialogRender(this)}
                <Toolbar>
                    <LinkButton to={`/settings/signal-sets/${sigSetId}/predictions/compare`} className="btn-primary"
                        //icon="plus"
                        label={t('Compare models')} />
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