// Auto Activity: generates editor activity on timers.
//
// Safety rule for the whole file: nothing here ever saves, creates or edits a
// document. Every action only looks at files: moving the cursor, selecting,
// scrolling, finding, and opening or closing tabs. The mouse feature only moves
// the pointer; it never clicks and never presses a key.

const vscode = require('vscode');
const path = require('path');
const { spawn } = require('child_process');

const ACTION_TIMEOUT_MS = 20000; // an action that hangs is abandoned after this long

let statusItem;
let channel; // "Auto Activity" in the Output panel: one line per action
let timer; // random-action timer
let selectScrollTimer; // select + scroll timer
let running = false;
let runId = 0; // bumped on every start/stop so in-flight actions can bail out
let pending = 0; // actions waiting or running
let queue = Promise.resolve(); // actions run one at a time, in order
let warnedNoFile = false;

function cfg() {
  return vscode.workspace.getConfiguration('autoActivity');
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function secondsRange(minKey, maxKey, minDefault, maxDefault) {
  const min = Math.max(1, Number(cfg().get(minKey, minDefault)) || minDefault);
  const max = Math.max(min, Number(cfg().get(maxKey, maxDefault)) || min);
  return randInt(min * 1000, max * 1000);
}

function log(message) {
  if (!channel) return;
  try {
    channel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  } catch (err) {
    // The channel is already closed while VS Code shuts down; nothing to log to.
  }
}

function fileLabel(doc) {
  return path.basename(doc.fileName);
}

function render() {
  if (!statusItem) return;
  // Icon only, no title text.
  statusItem.text = running ? '$(pulse)' : '$(circle-slash)';
  statusItem.tooltip = running ? 'Running - click to stop' : 'Stopped - click to start';
  if (cfg().get('showStatusBar', true)) statusItem.show();
  else statusItem.hide();
}

// --- timers ----------------------------------------------------------------
// Each timer re-arms itself the moment it fires, before its action runs, so
// the rhythm never depends on how long an action takes or whether it fails.
// Actions are queued and run one at a time.

function enqueue(name, fn) {
  if (!running || pending >= 2) return; // never let a backlog build up
  const id = runId;
  pending++;
  queue = queue.then(async () => {
    try {
      if (id !== runId) return;
      const result = await Promise.race([
        fn(id),
        sleep(ACTION_TIMEOUT_MS).then(() => 'timed out'),
      ]);
      if (id === runId) log(`${name}: ${result || 'done'}`);
    } catch (err) {
      log(`${name}: error - ${err && err.message ? err.message : err}`);
    } finally {
      pending--;
    }
  });
}

// Timer 1: select a word, then scroll, every 10-15 seconds.
function armSelectScroll() {
  if (!running) return;
  selectScrollTimer = setTimeout(() => {
    armSelectScroll();
    enqueue('select+scroll', selectAndScroll);
  }, secondsRange('selectScrollMinSeconds', 'selectScrollMaxSeconds', 10, 15));
}

// Timer 2: one random other action per interval.
function armRandom() {
  if (!running) return;
  timer = setTimeout(() => {
    armRandom();
    const c = cfg();
    const actions = [];
    if (c.get('moveCursor', true)) actions.push(['move cursor', moveCursor]);
    if (c.get('search', true)) actions.push(['search', search]);
    if (c.get('switchTabs', false)) actions.push(['switch tab', switchTab]);
    if (c.get('openCloseFiles', true)) actions.push(['open/close file', openOrCloseFile]);
    if (!actions.length) return;
    const [name, fn] = actions[randInt(0, actions.length - 1)];
    enqueue(name, fn);
  }, secondsRange('minSeconds', 'maxSeconds', 5, 20));
}

// --- finding a file to work in ----------------------------------------------

const MAX_OPEN_FILES = 4;
const FILE_EXCLUDE = '**/{node_modules,.git,out,dist,build,.vscode-test}/**';
const SKIP_EXT = /\.(png|jpe?g|gif|bmp|ico|webp|pdf|docx?|xlsx?|pptx?|zip|7z|rar|gz|tar|exe|dll|bin|vsix|mp3|mp4|mov|woff2?|ttf|lock)$/i;
const openedByUs = []; // uri strings of tabs this extension opened, oldest first

function hasText(doc) {
  return doc.lineCount > 1 || doc.lineAt(0).text.trim().length > 0;
}

function findTab(uriString) {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uriString) {
        return tab;
      }
    }
  }
  return undefined;
}

// Opens a text file from the project folder shown in the Explorer.
async function openProjectFile() {
  const files = await vscode.workspace.findFiles('**/*', FILE_EXCLUDE, 500);
  const textFiles = files.filter((u) => !SKIP_EXT.test(u.path));
  const notOpenYet = textFiles.filter((u) => !findTab(u.toString()));
  const candidates = notOpenYet.length ? notOpenYet : textFiles;
  for (let attempt = 0; attempt < 6 && candidates.length; attempt++) {
    const [uri] = candidates.splice(randInt(0, candidates.length - 1), 1);
    let doc;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      continue; // binary or unreadable, try another one
    }
    if (!hasText(doc)) continue;
    const hadTab = Boolean(findTab(uri.toString()));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    if (!hadTab) openedByUs.push(uri.toString());
    return editor;
  }
  return undefined;
}

// Returns an editor that has text in it. If the active tab is empty, is not a
// text file, or nothing is open at all, a project file is opened first, so the
// timers always have something to act on.
async function ensureEditor() {
  const active = vscode.window.activeTextEditor;
  if (active && hasText(active.document)) return active;

  const visible = vscode.window.visibleTextEditors.find(
    (e) => e.viewColumn !== undefined && hasText(e.document)
  );
  if (visible) {
    return vscode.window.showTextDocument(visible.document, { viewColumn: visible.viewColumn });
  }

  const opened = await openProjectFile();
  if (!opened && !warnedNoFile) {
    warnedNoFile = true;
    vscode.window.showWarningMessage(
      'Auto Activity needs a text file to work in. Open a folder or a file and it will carry on by itself.'
    );
  }
  return opened;
}

// --- actions (each returns a short description for the log) -----------------

async function selectAndScroll(id) {
  const editor = await ensureEditor();
  if (!editor) return 'no text file available';
  const c = cfg();
  const parts = [];
  if (c.get('selectWord', true)) {
    const word = selectWord(editor);
    parts.push(word ? `selected "${word}"` : 'no word found');
    await sleep(randInt(400, 900));
  }
  if (id === runId && c.get('scroll', true)) {
    parts.push(await scroll(editor, id));
  }
  return `${parts.join(', ')} in ${fileLabel(editor.document)}`;
}

// Finds a word on a line that is currently on screen, falling back to the
// first word anywhere in the file.
function pickWord(editor) {
  const doc = editor.document;
  const lastLine = doc.lineCount - 1;
  const view = editor.visibleRanges[0];
  const from = view ? view.start.line : 0;
  const to = view ? Math.min(view.end.line, lastLine) : Math.min(lastLine, 30);
  const wordsOn = (line) => [...doc.lineAt(line).text.matchAll(/[A-Za-z_]\w{2,}/g)];
  const toWord = (line, m) => ({ line, start: m.index, end: m.index + m[0].length, word: m[0] });

  for (let attempt = 0; attempt < 12; attempt++) {
    const line = randInt(from, to);
    const matches = wordsOn(line);
    if (matches.length) return toWord(line, matches[randInt(0, matches.length - 1)]);
  }
  for (let line = 0; line <= Math.min(lastLine, 3000); line++) {
    const matches = wordsOn(line);
    if (matches.length) return toWord(line, matches[0]);
  }
  return undefined;
}

// Selects a whole word, as a double-click would. Returns the word.
function selectWord(editor) {
  const w = pickWord(editor);
  if (!w) return undefined;
  const range = new vscode.Range(new vscode.Position(w.line, w.start), new vscode.Position(w.line, w.end));
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  return w.word;
}

// Scrolls in several small steps, like a mouse wheel, and now and then by a
// whole page. At the top of a file it always goes down and at the bottom it
// always goes up, so a scroll is never a silent no-op.
async function scroll(editor, id) {
  const lastLine = editor.document.lineCount - 1;
  if (lastLine < 1) return 'file too short to scroll';
  const view = editor.visibleRanges[0];
  let top = view ? view.start.line : 0;
  const bottom = view ? view.end.line : top;
  const page = Math.max(5, bottom - top);

  let dir = Math.random() < 0.5 ? -1 : 1;
  if (top <= 0) dir = 1;
  else if (bottom >= lastLine) dir = -1;

  const steps = Math.random() < 0.2
    ? [page]
    : Array.from({ length: randInt(3, 10) }, () => randInt(1, 3));
  const startTop = top;
  for (const lines of steps) {
    if (id !== runId) break;
    top = Math.min(lastLine, Math.max(0, top + dir * lines));
    const pos = new vscode.Position(top, 0);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
    await sleep(randInt(60, 220));
  }
  return `scrolled ${dir > 0 ? 'down' : 'up'} ${Math.abs(top - startTop)} lines`;
}

async function moveCursor() {
  const editor = await ensureEditor();
  if (!editor) return 'no text file available';
  const doc = editor.document;
  const current = editor.selection.active.line;
  const line = Math.min(doc.lineCount - 1, Math.max(0, current + randInt(-8, 8)));
  const col = randInt(0, doc.lineAt(line).text.length);
  const pos = new vscode.Position(line, col);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  return `line ${line + 1} in ${fileLabel(doc)}`;
}

// Opens the Find box with a word from the file, steps through a few matches,
// then closes the box. Find only looks; it never replaces anything.
async function search(id) {
  const editor = await ensureEditor();
  if (!editor) return 'no text file available';
  const w = pickWord(editor);
  if (!w) return 'no word found';
  await vscode.commands.executeCommand('editor.actions.findWithArgs', {
    searchString: w.word,
    isRegex: false,
    matchWholeWord: false,
    isCaseSensitive: false,
  });
  let hopsDone = 0;
  try {
    const hops = randInt(2, 5);
    for (let i = 0; i < hops; i++) {
      await sleep(randInt(400, 1100));
      if (id !== runId) break;
      await vscode.commands.executeCommand('editor.action.nextMatchFindAction');
      hopsDone++;
    }
    await sleep(randInt(400, 900));
  } finally {
    await vscode.commands.executeCommand('closeFindWidget');
  }
  return `"${w.word}", ${hopsDone} matches visited in ${fileLabel(editor.document)}`;
}

async function switchTab() {
  await vscode.commands.executeCommand('workbench.action.nextEditor');
  return 'next tab';
}

// Only tabs this extension opened itself are ever closed, and never a tab with
// unsaved changes.
async function closeOneOfOurs() {
  const uriString = openedByUs.shift();
  if (!uriString) return undefined;
  const tab = findTab(uriString);
  if (tab && !tab.isDirty) {
    await vscode.window.tabGroups.close(tab);
    return tab.label;
  }
  return undefined;
}

async function openOrCloseFile() {
  if (openedByUs.length >= MAX_OPEN_FILES || (openedByUs.length > 1 && Math.random() < 0.4)) {
    const label = await closeOneOfOurs();
    return label ? `closed ${label}` : 'nothing to close';
  }
  const editor = await openProjectFile();
  return editor ? `opened ${fileLabel(editor.document)}` : 'no project file to open';
}

async function closeAllOfOurs() {
  while (openedByUs.length) await closeOneOfOurs();
}

// --- mouse -------------------------------------------------------------------
// Moves the real mouse pointer along curved, eased paths for a few seconds at
// a time. Windows only: a hidden PowerShell process calls user32.dll, so no
// native node module is needed. It runs on its own timer, beside the editor
// actions, and only ever moves the pointer.

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct WPoint { public int X; public int Y; }
public static class W {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out WPoint p);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
'@
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  switch ($p[0]) {
    'M' { [void][W]::SetCursorPos([int]$p[1], [int]$p[2]) }
    'P' {
      $pt = New-Object WPoint
      [void][W]::GetCursorPos([ref]$pt)
      [Console]::Out.WriteLine("$($pt.X) $($pt.Y)")
    }
    'S' { [Console]::Out.WriteLine("$([W]::GetSystemMetrics(0)) $([W]::GetSystemMetrics(1))") }
  }
}
`;

const BRIDGE_START_TIMEOUT_MS = 20000;
const MOUSE_MARGIN = 60; // keep the pointer this far from the screen edges
const USER_MOVED_PX = 4; // pointer further than this from where we left it: the user moved it

let bridge; // running PowerShell helper, if any
let bridgeStarting; // promise while the helper is starting
let mouseTimer;
let mouseUnavailable = false; // helper failed to start; do not retry until the next start
let screenSize = { w: 1920, h: 1080 };

const rand = (min, max) => Math.random() * (max - min) + min;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

class MouseBridge {
  constructor(proc) {
    this.proc = proc;
    this.buf = '';
    this.waiters = []; // one resolver per expected output line, oldest first
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
      }
    });
    const fail = () => {
      this.waiters.splice(0).forEach((w) => w(''));
      if (bridge === this) bridge = undefined;
    };
    proc.on('exit', fail);
    proc.on('error', fail);
    proc.stdin.on('error', () => {}); // helper already gone; 'exit' handles it
    proc.stderr.on('data', (d) => log(`mouse helper: ${String(d).trim()}`));
  }

  static async create() {
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true }
    );
    const b = new MouseBridge(proc);
    const ready = await Promise.race([
      new Promise((resolve) => b.waiters.push(resolve)),
      sleep(BRIDGE_START_TIMEOUT_MS).then(() => 'TIMEOUT'),
    ]);
    if (ready !== 'READY') {
      b.dispose();
      throw new Error(`PowerShell helper did not start (got: ${ready || 'nothing'})`);
    }
    return b;
  }

  send(line) {
    if (this.proc.stdin.writable) this.proc.stdin.write(line + '\n');
  }

  ask(line) {
    return new Promise((resolve) => {
      if (!this.proc.stdin.writable) return resolve('');
      this.waiters.push(resolve);
      this.send(line);
    });
  }

  async position() {
    const [x, y] = (await this.ask('P')).split(' ').map(Number);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  }

  dispose() {
    try { this.proc.stdin.end(); } catch (err) { /* already closed */ }
    try { this.proc.kill(); } catch (err) { /* already gone */ }
  }
}

// Starts the helper on first use. Returns undefined if it cannot be started.
async function getBridge(id) {
  if (bridge) return bridge;
  if (mouseUnavailable) return undefined;
  if (!bridgeStarting) {
    bridgeStarting = (async () => {
      try {
        const b = await MouseBridge.create();
        const [w, h] = (await b.ask('S')).split(' ').map(Number);
        if (w > 0 && h > 0) screenSize = { w, h };
        return b;
      } catch (err) {
        mouseUnavailable = true;
        log(`mouse: helper failed - ${err && err.message ? err.message : err}`);
        vscode.window.showWarningMessage(
          'Auto Activity: could not start the mouse helper (PowerShell). Mouse movement is off; everything else keeps running.'
        );
        return undefined;
      } finally {
        bridgeStarting = undefined;
      }
    })();
  }
  const b = await bridgeStarting;
  if (b && id !== runId) {
    // stopped while the helper was starting
    b.dispose();
    return undefined;
  }
  if (b) bridge = b;
  return b;
}

function disposeBridge() {
  if (bridge) bridge.dispose();
  bridge = undefined;
}

function mouseAllowed() {
  const c = cfg();
  if (!c.get('moveMouse', true)) return false;
  return !c.get('mousePauseWhenUnfocused', true) || vscode.window.state.focused;
}

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

// Moves the pointer from one point to another along a curved, eased path.
// Returns the last point actually sent, which is `to` unless it was cut short.
async function glide(b, from, to, canContinue, jitter = true) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2) return from;

  // duration grows with distance, plus a short settle time
  const duration = clamp((dist / rand(450, 900)) * 1000 + rand(150, 400), 250, 3000);
  const steps = Math.max(20, Math.round(duration / 12));

  // curved path: control points pushed sideways from the straight line
  const nx = -dy / dist;
  const ny = dx / dist;
  const bend = rand(-0.2, 0.2) * dist;
  const c1 = { x: from.x + dx * 0.3 + nx * bend, y: from.y + dy * 0.3 + ny * bend };
  const c2 = {
    x: from.x + dx * 0.7 + nx * bend * rand(0.3, 1),
    y: from.y + dy * 0.7 + ny * bend * rand(0.3, 1),
  };

  let last = from;
  for (let i = 1; i <= steps; i++) {
    if (!canContinue()) break;
    const p = bezier(from, c1, c2, to, ease(i / steps));
    const j = jitter && i < steps ? 1 : 0;
    last = {
      x: clamp(Math.round(p.x + rand(-j, j)), 0, screenSize.w - 1),
      y: clamp(Math.round(p.y + rand(-j, j)), 0, screenSize.h - 1),
    };
    b.send(`M ${last.x} ${last.y}`);
    await sleep((duration / steps) * rand(0.8, 1.25));
  }
  return last;
}

// One wandering session: a series of glides to nearby points for 10-15
// seconds. Stops at once if the user moves the mouse themselves.
async function moveMouse(id) {
  if (!mouseAllowed()) return 'skipped, window not focused';
  const b = await getBridge(id);
  if (!b) return 'helper not available';
  const canContinue = () => running && id === runId && bridge === b && mouseAllowed();

  const { w, h } = screenSize;
  const endAt = Date.now() + secondsRange('mouseSessionMinSeconds', 'mouseSessionMaxSeconds', 10, 15);
  let pos = await b.position();
  let moves = 0;

  while (pos && canContinue() && Date.now() < endAt) {
    const target = {
      x: clamp(pos.x + randInt(-500, 500), MOUSE_MARGIN, w - MOUSE_MARGIN),
      y: clamp(pos.y + randInt(-350, 350), MOUSE_MARGIN, h - MOUSE_MARGIN),
    };

    // now and then overshoot a little, then correct
    if (Math.random() < 0.25) {
      const over = {
        x: clamp(target.x + randInt(-25, 25), 0, w - 1),
        y: clamp(target.y + randInt(-25, 25), 0, h - 1),
      };
      pos = await glide(b, pos, over, canContinue);
      await sleep(rand(60, 180));
      pos = await glide(b, pos, target, canContinue, false);
    } else {
      pos = await glide(b, pos, target, canContinue);
    }
    moves++;
    await sleep(rand(50, 400));

    const actual = await b.position();
    if (!actual) break;
    if (Math.hypot(actual.x - pos.x, actual.y - pos.y) > USER_MOVED_PX) {
      return `${moves} moves, then stopped because you moved the mouse`;
    }
    pos = actual;
  }
  return `${moves} moves`;
}

// Timer 3: a mouse session, a pause, the next session. Unlike the other two
// timers this one re-arms after the session ends, since a session is long.
function armMouse(delayMs) {
  if (!running) return;
  const id = runId;
  const delay = delayMs !== undefined
    ? delayMs
    : secondsRange('mousePauseMinSeconds', 'mousePauseMaxSeconds', 5, 20);
  mouseTimer = setTimeout(async () => {
    if (cfg().get('moveMouse', true)) {
      try {
        const result = await moveMouse(id);
        if (id === runId) log(`mouse: ${result}`);
      } catch (err) {
        log(`mouse: error - ${err && err.message ? err.message : err}`);
      }
    }
    if (id === runId) armMouse();
  }, delay);
}

// --- commands --------------------------------------------------------------

function start() {
  if (running) return;
  running = true;
  runId++;
  pending = 0;
  queue = Promise.resolve();
  warnedNoFile = false;
  render();
  log('started');
  enqueue('select+scroll', selectAndScroll); // first step right away, then on the timer
  armSelectScroll();
  armRandom();
  mouseUnavailable = false;
  if (process.platform === 'win32') armMouse(randInt(1000, 3000));
  else if (cfg().get('moveMouse', true)) log('mouse: only supported on Windows, skipped');
}

async function stop() {
  if (!running) return;
  running = false;
  runId++;
  clearTimeout(timer);
  clearTimeout(selectScrollTimer);
  clearTimeout(mouseTimer);
  timer = undefined;
  selectScrollTimer = undefined;
  mouseTimer = undefined;
  disposeBridge();
  render();
  log('stopped');
  try {
    await closeAllOfOurs();
  } catch (err) {
    log(`stop: error - ${err && err.message ? err.message : err}`);
  }
}

function toggle() {
  return running ? stop() : start();
}

function activate(context) {
  channel = vscode.window.createOutputChannel('Auto Activity');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'autoActivity.toggle';
  render();

  context.subscriptions.push(
    channel,
    statusItem,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('autoActivity')) render();
    }),
    vscode.commands.registerCommand('autoActivity.start', start),
    vscode.commands.registerCommand('autoActivity.stop', stop),
    vscode.commands.registerCommand('autoActivity.toggle', toggle)
  );

  if (cfg().get('startOnLaunch', false)) start();
}

function deactivate() {
  return stop();
}

module.exports = { activate, deactivate };
