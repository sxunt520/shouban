import { MigrationInterface, QueryRunner, Table, TableColumn } from 'typeorm';
export class R1mNfc1791561600000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    for (const c of [new TableColumn({ name: 'lastNfcConnectionId', type: 'varchar', length: '64', isNullable: true }), new TableColumn({ name: 'lastNfcSequence', type: 'int', unsigned: true, default: '0' })]) {
      if (!await runner.hasColumn('figure_devices', c.name)) await runner.addColumn('figure_devices', c);
    }
    if (!await runner.hasTable('figure_nfc_bindings')) await runner.createTable(new Table({ name: 'figure_nfc_bindings', columns: [
      { name: 'id', type: 'varchar', length: '36', isPrimary: true },
      { name: 'userId', type: 'varchar', length: '64' }, { name: 'uid', type: 'varchar', length: '20' }, { name: 'characterId', type: 'varchar', length: '64' },
      { name: 'createdAt', type: 'datetime', precision: 3, default: 'CURRENT_TIMESTAMP(3)' },
    ], indices: [{ name: 'IDX_nfc_owner_uid', columnNames: ['userId', 'uid'], isUnique: true }] }));
  }
  async down(): Promise<void> { throw new Error('Preserve NFC bindings and ordering state when rolling back application code'); }
}
