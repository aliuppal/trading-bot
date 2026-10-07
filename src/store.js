import fs from 'node:fs';
import path from 'node:path';

export class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
  }
  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return structuredClone(this.defaults);
    }
  }
  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
