import { EventEmitter } from 'node:events';
import { AlarmTransitions } from './domain';
import type { Store } from './database';
import type { Connection } from './rust/connection';

export class Devices extends EventEmitter {
  readonly states = new Map<string, boolean>();
  readonly busy = new Set<string>();
  private alarms: AlarmTransitions;
  constructor(
    readonly store: Store,
    readonly rust: Connection,
    cooldownSeconds: number,
  ) {
    super();
    this.alarms = new AlarmTransitions(
      cooldownSeconds * 1000,
      (id) => store.lastAlert(id),
      (id, at) => store.saveAlert(id, at),
    );
    rust.on('status', () => {
      if (!rust.online) {
        this.states.clear();
        this.alarms.reset();
      }
      this.emit('update');
    });
    rust.on('deviceError', (id: string) => {
      this.states.delete(id);
      this.emit('update');
    });
    rust.on('device', (id: string, value: boolean, initial: boolean) => {
      const device = store.devices().find((d) => d.id === id);
      if (!device) return;
      this.states.set(id, value);
      if (initial) this.alarms.sync(id, value);
      else if (device.type === 'alarm' && this.alarms.change(id, value, device.enabled))
        this.emit('alarm', device);
      this.emit('update');
    });
  }
  async control(id: string, action: 'on' | 'off' | 'refresh'): Promise<boolean> {
    if (this.store.device(id).type !== 'switch')
      throw new Error('Select a registered Smart Switch.');
    if (this.busy.has(id)) throw new Error('A request for this switch is already running.');
    this.busy.add(id);
    this.emit('update');
    try {
      return action === 'refresh'
        ? await this.rust.queryDevice(id)
        : await this.rust.setSwitch(id, action === 'on');
    } finally {
      this.busy.delete(id);
      this.emit('update');
    }
  }
}
