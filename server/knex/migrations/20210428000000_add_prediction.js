const shareableEntityTypes = ['prediction'];

exports.up = (knex, Promise) => (async () => {
    await knex.schema.dropTableIfExists('shares_prediction');
    await knex.schema.dropTableIfExists('permissions_prediction');
    await knex.schema.dropTableIfExists('predictions');

    await knex.schema.createTable('predictions', table => {
        table.increments('id').primary();
        table.integer('set').unsigned().notNullable()
            .references('signal_sets.id')
            .onDelete('CASCADE'); // delete predictions if its owner set gets deleted
        table.string('name');
        table.string('type');
        table.integer('ahead_count').unsigned().notNullable();
        table.integer('future_count').unsigned().notNullable();
        table.text('settings', 'longtext');
        table.timestamp('created').defaultsTo(knex.fn.now());
        table.integer('namespace').notNullable().references('namespaces.id');
    });

    await knex.schema.createTable('predictions_jobs', table => {
        table.integer('prediction').unsigned().notNullable().references('predictions.id')
            .onDelete('CASCADE');
        table.integer('job').unsigned().notNullable().references('jobs.id')
            .onDelete('RESTRICT'); // job should not ever be deleted if it's
                                   // used by a prediction model
    });

    // OUTPUT signal sets
    await knex.schema.createTable('predictions_signal_sets', table => {
        table.integer('prediction').unsigned().notNullable().references('predictions.id')
            .onDelete('CASCADE');
        table.integer('set').unsigned().notNullable().references('signal_sets.id')
            .onDelete('RESTRICT'); // output set should not be deleted before model
    });

    // OUTPUT signals
    await knex.schema.createTable('predictions_signals', table => {
        table.integer('prediction').unsigned().notNullable().references('predictions.id')
            .onDelete('CASCADE');
        table.integer('signal').unsigned().notNullable().references('signals.id')
            .onDelete('RESTRICT'); // output signal should not be deleted before model
        // add type (main, ts, extra)
    });

    // Permissions - based on 20170506102634_base.js
    for (const entityType of shareableEntityTypes) {
        await knex.schema
            .createTable(
                `shares_${entityType}`, table => {
                    table.integer('entity').unsigned().notNullable().references(`${entityType}s.id`).onDelete('CASCADE');
                    table.integer('user').unsigned().notNullable().references('users.id').onDelete('CASCADE');
                    table.string('role', 128).notNullable();
                    table.boolean('auto').defaultTo(false);
                    table.primary(['entity', 'user']);
                })
            .createTable(`permissions_${entityType}`, table => {
                table.integer('entity').unsigned().notNullable().references(`${entityType}s.id`).onDelete('CASCADE');
                table.integer('user').unsigned().notNullable().references('users.id').onDelete('CASCADE');
                table.string('operation', 128).notNullable();
                table.primary(['entity', 'user', 'operation']);
            });
    }
})();

exports.down = (knex, Promise) => (async () => {
    await knex.schema.dropTableIfExists('shares_prediction');
    await knex.schema.dropTableIfExists('permissions_prediction');
    await knex.schema.dropTableIfExists('predictions_jobs');
    await knex.schema.dropTableIfExists('predictions_signal_sets');
    await knex.schema.dropTableIfExists('predictions_signals');
    await knex.schema.dropTableIfExists('predictions');
});