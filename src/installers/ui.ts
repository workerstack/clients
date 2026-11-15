/** Rows like the installers': a mark, a label, a value. Marks and color on a TTY; plain `+`, `x`, `!` otherwise. */
export type Ui = {
  ok(label: string, value: string): void;
  bad(label: string, value: string): void;
  info(text: string): void;
  warn(text: string): void;
  error(text: string): void;
};

export type UiIo = {
  stdout(text: string): void;
  stderr(text: string): void;
  isTTY: boolean;
  env: Record<string, string | undefined>;
};

const ESC = "\u001b";
const row = (glyph: string, label: string, value: string) => `${glyph} ${label.padEnd(13)} ${value}\n`;

export function createUi(io: UiIo): Ui {
  const color = io.isTTY && !io.env.NO_COLOR;
  const paint = (code: number, text: string) => (color ? `${ESC}[${code}m${text}${ESC}[0m` : text);
  const mark = { bad: io.isTTY ? "✗" : "x", ok: io.isTTY ? "✓" : "+" };

  return {
    bad: (label, value) => io.stdout(row(paint(31, mark.bad), label, value)),
    error: (text) => io.stderr(`${paint(31, io.isTTY ? `${mark.bad} error:` : "error:")} ${text}\n`),
    info: (text) => io.stdout(`${text}\n`),
    ok: (label, value) => io.stdout(row(paint(32, mark.ok), label, value)),
    warn: (text) => io.stderr(`${paint(33, "warning:")} ${text}\n`),
  };
}
