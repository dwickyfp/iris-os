import type { ExecutionDriver } from "../execution-driver";

export class ExecutionDriverRegistry {
  private readonly drivers = new Map<string, ExecutionDriver>();

  constructor(drivers: readonly ExecutionDriver[] = []) {
    for (const driver of drivers) this.register(driver);
  }

  register(driver: ExecutionDriver) {
    if (this.drivers.has(driver.id))
      throw new Error(`Execution driver already registered: ${driver.id}`);
    this.drivers.set(driver.id, driver);
  }

  get(id: string) {
    const driver = this.drivers.get(id);
    if (!driver) throw new Error(`Execution driver not found: ${id}`);
    return driver;
  }

  has(id: string) {
    return this.drivers.has(id);
  }
}
