import { createInterface } from "node:readline";

export async function readPassword(fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    return (await Bun.stdin.text()).replace(/\r?\n$/, "");
  }
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    throw new Error("A terminal is required to enter a password. Use --stdin for a pipe.");
  }
  const wasRaw = stdin.isRaw;
  const reader = createInterface({ input: stdin, terminal: false });
  process.stderr.write("Password: ");
  try {
    stdin.setRawMode(true);
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      reader.once("close", () => reject(new Error("Password input cancelled.")));
      stdin.setEncoding("utf8");
      const handle = (chunk: string): void => {
        for (const char of chunk) {
          if (char === "\x03" || char === "\x04") {
            reject(new Error("Password input cancelled."));
            return;
          }
          if (char === "\r" || char === "\n") {
            resolve(value);
            return;
          }
          if (char === "\x7f" || char === "\b") {
            value = [...value].slice(0, -1).join("");
          } else {
            value += char;
          }
        }
      };
      stdin.on("data", handle);
      reader.once("close", () => stdin.off("data", handle));
    });
  } finally {
    reader.close();
    stdin.setRawMode(wasRaw);
    stdin.pause();
    process.stderr.write("\n");
  }
}
