import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';
export class R1mCloudReminder1791558000000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    for (const c of [
      new TableColumn({ name: 'lastRunStatus', type: 'varchar', length: '32', isNullable: true }),
      new TableColumn({ name: 'lastRunReason', type: 'varchar', length: '200', isNullable: true }),
      new TableColumn({ name: 'lastCommandId', type: 'char', length: '36', isNullable: true }),
      new TableColumn({ name: 'lastOccurrenceAt', type: 'datetime', precision: 3, isNullable: true }),
    ]) if (!await runner.hasColumn('figure_reminders', c.name)) await runner.addColumn('figure_reminders', c);
  }
  async down(): Promise<void> { throw new Error('Preserve reminder execution records when rolling back application code'); }
}
