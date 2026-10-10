export interface Principal {
  id: string;
  guildId: string | null;
  administrator: boolean;
  roles: readonly string[];
}
export class Permissions {
  constructor(
    private guildId: string,
    private adminId: string,
    private roles: () => readonly string[],
  ) {}
  admin(p: Principal): boolean {
    return p.guildId === this.guildId && (p.id === this.adminId || p.administrator);
  }
  operate(p: Principal): boolean {
    return (
      this.admin(p) || (p.guildId === this.guildId && p.roles.some((r) => this.roles().includes(r)))
    );
  }
}
