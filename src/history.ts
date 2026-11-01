export interface Entry { label: string; undo(): void; redo(): void }

export class History {
  private stack: Entry[] = [];
  private idx = 0;
  onChange: () => void = () => {};
  dirty = false;
  push(e: Entry) {
    this.stack.length = this.idx;
    this.stack.push(e);
    if (this.stack.length > 100) this.stack.shift();
    this.idx = this.stack.length;
    this.dirty = true;
    this.onChange();
  }
  /** Fold the last two entries into a single undo step (e.g. a pixel edit plus the selection change that goes with it). */
  merge(label?: string) {
    if (this.idx < 2) return;
    const b = this.stack[this.idx - 1], a = this.stack[this.idx - 2];
    this.stack.splice(this.idx - 2, 2, { label: label ?? a.label, undo: () => { b.undo(); a.undo(); }, redo: () => { a.redo(); b.redo(); } });
    this.idx--;
    this.onChange();
  }
  /** Number of undoable steps currently applied (used by tests). */
  get depth() { return this.idx; }
  get canUndo() { return this.idx > 0; }
  get canRedo() { return this.idx < this.stack.length; }
  get undoLabel() { return this.canUndo ? this.stack[this.idx - 1].label : ''; }
  get redoLabel() { return this.canRedo ? this.stack[this.idx].label : ''; }
  undo() { if (this.canUndo) { this.stack[--this.idx].undo(); this.dirty = true; this.onChange(); } }
  redo() { if (this.canRedo) { this.stack[this.idx++].redo(); this.dirty = true; this.onChange(); } }
}
