import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/** Additive migration for installations that disable TypeORM schema sync. */
export class DeviceIntegration1791417600000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const additions: Record<string, TableColumn[]> = {
      figure_devices: [
        new TableColumn({ name: 'protocolProfile', type: 'varchar', length: '40', default: "'legacy'" }),
        new TableColumn({ name: 'externalDeviceId', type: 'varchar', length: '64', isNullable: true }),
        new TableColumn({ name: 'clientUuid', type: 'varchar', length: '64', isNullable: true }),
        new TableColumn({ name: 'capabilities', type: 'text', isNullable: true }),
        new TableColumn({ name: 'desiredVolume', type: 'tinyint', unsigned: true, isNullable: true }),
        ...['controlRevision', 'reportedRevision', 'mqttSequence'].map(name => new TableColumn({ name, type: 'int', unsigned: true, default: '0' })),
        new TableColumn({ name: 'mqttOnline', type: 'tinyint', default: '0' }),
        new TableColumn({ name: 'mqttConnectionId', type: 'varchar', length: '64', isNullable: true }),
      ],
      figure_device_commands: [
        new TableColumn({ name: 'status', type: 'varchar', length: '16', default: "'pending'" }),
        new TableColumn({ name: 'requestedByUserId', type: 'varchar', length: '64', isNullable: true }),
        new TableColumn({ name: 'revision', type: 'int', unsigned: true, isNullable: true }),
        ...['expiresAt', 'lastDispatchedAt', 'completedAt'].map(name => new TableColumn({ name, type: 'datetime', precision: 3, isNullable: true })),
        new TableColumn({ name: 'attempts', type: 'int', unsigned: true, default: '0' }),
        new TableColumn({ name: 'failureReason', type: 'varchar', length: '500', isNullable: true }),
        new TableColumn({ name: 'result', type: 'text', isNullable: true }),
      ],
      figure_device_events: [new TableColumn({ name: 'externalEventId', type: 'varchar', length: '80', isNullable: true })],
    };
    for (const [table, columns] of Object.entries(additions)) {
      for (const column of columns) if (!(await runner.hasColumn(table, column.name))) await runner.addColumn(table, column);
    }
    const indexes: Array<[string, TableIndex]> = [
      ['figure_devices', new TableIndex({ name: 'IDX_device_external_identity', columnNames: ['externalDeviceId'], isUnique: true })],
      ['figure_device_commands', new TableIndex({ name: 'IDX_device_command_lifecycle', columnNames: ['deviceId', 'status', 'createdAt'] })],
      ['figure_device_events', new TableIndex({ name: 'IDX_device_external_event', columnNames: ['deviceId', 'externalEventId'], isUnique: true })],
    ];
    for (const [tableName, index] of indexes) {
      const table = await runner.getTable(tableName);
      if (!table?.indices.some(existing => existing.isUnique === index.isUnique && existing.columnNames.join(',') === index.columnNames.join(','))) {
        await runner.createIndex(tableName, index);
      }
    }
    await runner.query("UPDATE figure_device_commands SET status='succeeded', completedAt=acknowledgedAt WHERE acknowledgedAt IS NOT NULL AND status='pending'");
  }

  async down(): Promise<void> {
    // Dropping columns would destroy execution history. Roll back application
    // code while preserving these additive fields, or restore a reviewed backup.
    throw new Error('Device integration migration requires a reviewed data-preserving rollback');
  }
}
