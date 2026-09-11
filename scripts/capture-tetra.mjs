import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.SHOWCASE_URL ?? "http://localhost:3000";

const LOOP = 26;
const FPS = 30;
/** Сторона холста */
const SIZE = 1300;
const VIEWS = [
  { side: 900, crf: 29, file: "tetra.webm" },
  { side: 1300, crf: 31, file: "tetra-2x.webm" },
];
/** Порт отладки: браузер поднимается свой, чужой не трогаем */
const PORT = 9333;

const out = resolve(root, "public/landing");

/** Где искать браузер */
const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const CLOCK = `(() => {
  const STEP = ${1000 / FPS};
  let now = 0;
  let queue = [];
  performance.now = () => now;
  window.requestAnimationFrame = (fn) => queue.push(fn);
  window.cancelAnimationFrame = () => {};
  window.__frame = () => {
    const due = queue;
    queue = [];
    for (const fn of due) fn(now);
    now += STEP;
    const canvas = document.querySelector("canvas");
    // Холст читается в том же такте, что и отрисовка, — иначе буфер уже пуст.
    return canvas ? canvas.toDataURL("image/png").slice(22) : null;
  };
})();`;

async function findBrowser() {
  for (const candidate of BROWSERS) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Идем дальше по списку
    }
  }
  throw new Error("Не найден Chrome или Edge — снимать нечем.");
}

async function reachable(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok || response.status === 405;
  } catch {
    return false;
  }
}

/** Ждем, пока условие станет истинным, но не дольше отведенного */
async function until(check, limit, note) {
  for (let left = limit; left > 0; left -= 1) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(note);
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const waiting = new Map();
  let last = 0;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const seat = pending.get(message.id);
      if (!seat) return;
      pending.delete(message.id);
      if (message.error) seat.reject(new Error(message.error.message));
      else seat.resolve(message.result);
      return;
    }
    for (const done of waiting.get(message.method)?.splice(0) ?? []) done(message.params);
  });

  return {
    open: new Promise((ok, fail) => {
      socket.addEventListener("open", ok, { once: true });
      socket.addEventListener("error", () => fail(new Error("Браузер не отвечает")), {
        once: true,
      });
    }),
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        last += 1;
        pending.set(last, { resolve, reject });
        socket.send(JSON.stringify({ id: last, method, params }));
      }),
    once: (method) =>
      new Promise((done) => {
        if (!waiting.has(method)) waiting.set(method, []);
        waiting.get(method).push(done);
      }),
    close: () => socket.close(),
  };
}

const browser = await findBrowser();
if (!(await reachable(base))) {
  throw new Error(`Сервер ${base} не отвечает. Запустите «npm run dev» в другом окне.`);
}

const profile = await mkdtemp(resolve(tmpdir(), "tetra-"));
const frames = await mkdtemp(resolve(tmpdir(), "tetra-frames-"));
await mkdir(out, { recursive: true });

const chrome = spawn(browser, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${SIZE},${SIZE}`,
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--enable-unsafe-swiftshader",
  "about:blank",
]);
chrome.on("error", (error) => {
  throw error;
});

try {
  await until(
    () => reachable(`http://127.0.0.1:${PORT}/json/version`),
    40,
    "Браузер не поднял отладочный порт.",
  );
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("В браузере нет ни одной вкладки.");

  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.open;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: CLOCK });

  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: `${base}/lab/tetra` });
  await loaded;

  const ask = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  };

  await until(
    async () => (await ask(`!!document.querySelector("canvas")`)) === true,
    80,
    "Холст так и не появился — знак не собрался.",
  );

  const total = LOOP * FPS;
  for (let index = 0; index < total; index += 1) {
    const png = await ask("window.__frame()");
    if (!png) throw new Error(`Кадр ${index} снялся пустым.`);
    await writeFile(resolve(frames, `f${String(index).padStart(4, "0")}.png`), png, "base64");
    if (index % 60 === 0) console.log(`кадр ${index} из ${total}`);
  }
  cdp.close();

  for (const view of VIEWS) {
    await run("ffmpeg", [
      "-y",
      "-framerate",
      String(FPS),
      "-i",
      resolve(frames, "f%04d.png"),
      "-vf",
      `scale=${view.side}:${view.side}:flags=lanczos`,
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuva420p",
      "-b:v",
      "0",
      "-crf",
      String(view.crf),
      "-row-mt",
      "1",
      "-an",
      resolve(out, view.file),
    ]);
  }

  // Неподвижный кадр - для спокойного режима: движение там выключено
  await run("ffmpeg", [
    "-y",
    "-i",
    resolve(frames, "f0000.png"),
    "-vf",
    `scale=${VIEWS[1].side}:${VIEWS[1].side}:flags=lanczos`,
    "-c:v",
    "libwebp",
    "-quality",
    "88",
    resolve(out, "tetra-still.webp"),
  ]);

  for (const file of [...VIEWS.map((view) => view.file), "tetra-still.webp"]) {
    const written = await stat(resolve(out, file));
    console.log(`${file} — ${Math.round(written.size / 1024)} КБ`);
  }
} finally {
  chrome.kill();
  await rm(frames, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(
    () => {},
  );
}
