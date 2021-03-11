
const shareableEntityTypes = ['prediction'];

exports.up = (knex, Promise) => (async () => {
    // Predictions
    await knex.schema.createTable('predictions', table => {
        table.increments('id').primary();
        table.integer('sigSetId').unsigned().notNullable().references('signal_sets.id').onDelete('NO ACTION'); // TODO
        table.string('name');
        table.string('type');
        table.text('params', 'longtext');
        table.timestamp('created').defaultTo(knex.fn.now());
        table.integer('namespace').notNullable().references('namespaces.id'); // unsigned? fails on foreign key check
        table.string('signal_cid').notNullable();
        table.string('futr_cid').notNullable();
        table.string('hist_cid').notNullable();
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
});