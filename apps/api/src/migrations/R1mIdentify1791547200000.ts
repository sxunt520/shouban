import { MigrationInterface, QueryRunner } from 'typeorm';

/** Preserve existing command values and history while adding the R1M proposal command. */
export class R1mIdentify1791547200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const table = await runner.getTable('figure_device_commands');
    const column = table?.findColumnByName('type');
    if (!column) throw new Error('Device command schema must exist before R1M identify migration');
    if (column.type !== 'enum') throw new Error('Expected command type enum; review schema before migration');
    if (column.enum?.includes('identify_device')) return;
    const next = column.clone(); next.enum = [...(column.enum || []), 'identify_device'];
    await runner.changeColumn('figure_device_commands', column, next);
  }
  async down(): Promise<void> {
    throw new Error('Preserve identify execution history when rolling back application code');
  }
}
