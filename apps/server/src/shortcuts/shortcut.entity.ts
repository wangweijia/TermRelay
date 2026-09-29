import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'shortcuts' })
export class ShortcutEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'device_id', type: 'varchar', length: 128 })
  deviceId!: string;

  @Column({ type: 'bigint', transformer: { to: (value: number) => value, from: (value: string) => Number(value) } })
  revision!: number;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 2048 })
  description!: string;

  @Column({ name: 'workspace_id', type: 'varchar', length: 128 })
  workspaceId!: string;

  @Column({ name: 'proxy_mode', type: 'enum', enum: ['inherit', 'disabled', 'custom'] })
  proxyMode!: 'inherit' | 'disabled' | 'custom';

  @Column({ name: 'requires_confirmation', type: 'boolean' })
  requiresConfirmation!: boolean;
}
