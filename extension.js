// Auto Activity: generates editor activity on a timer.
//
// Safety rule for the whole file: nothing here ever saves, creates or edits a
// document. Every action only looks at files: moving the cursor, selecting,
// scrolling, finding, and opening or closing tabs.

const vscode = require('vscode');

let statusItem;
let timer; // random-action loop
let selectScrollTimer; // fixed select + scroll loop
let running = false;
let busy = false;
let runId = 0; // bumped on every start/stop so in-flight actions can bail out

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

function render() {
  if (!statusItem) return;
  // Icon only, no title text.
  statusItem.text = running ? '$(pulse)' : '$(circle-slash)';
  statusItem.tooltip = running ? 'Running - click to stop' : 'Stopped - click to start';
  if (cfg().get('showStatusBar', true)) statusItem.show();
  else statusItem.hide();
}

// --- loop 1: select a word, then scroll, every 10-15 seconds ----------------

function scheduleSelectScroll(delayMs) {
  if (!running) return;
  const delay = delayMs !== undefined
    ? delayMs
    : secondsRange('selectScrollMinSeconds', 'selectScrollMaxSeconds', 10, 15);
  selectScrollTimer = setTimeout(selectScrollTick, delay);
}

async function selectScrollTick() {
  if (!running) return;
  if (busy) return scheduleSelectScroll(1000); // another action is mid-flight, retry shortly
  busy = true;
  const id = runId;
  try {
    const c = cfg();
    if (c.get('selectWord', true)) {
      await selectWord();
      await sleep(randInt(400, 900));
    }
    if (id === runId && c.get('scroll', true)) {
      await scroll(id);
    }
  } catch (err) {
    console.error('[auto-activity]', err);
  } finally {
    busy = false;
    if (id === runId) scheduleSelectScroll();
  }
}

// --- loop 2: one random other action per interval ---------------------------

function scheduleNext() {
  if (!running) return;
  timer = setTimeout(tick, secondsRange('minSeconds', 'maxSeconds', 5, 20));
}

async function tick() {
  if (!running) return;
  if (busy) return scheduleNext();
  busy = true;
  const id = runId;
  try {
    const actions = [];
    const c = cfg();
    if (c.get('moveCursor', true)) actions.push(moveCursor);
    if (c.get('search', true)) actions.push(search);
    if (c.get('switchTabs', false)) actions.push(switchTab);
    if (c.get('openCloseFiles', true)) actions.push(openOrCloseFile);
    if (actions.length) {
      await actions[randInt(0, actions.length - 1)](id);
    }
  } catch (err) {
    console.error('[auto-activity]', err);
  } finally {
    busy = false;
    if (id === runId) scheduleNext();
  }
}

// --- actions ---------------------------------------------------------------

async function moveCursor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const current = editor.selection.active.line;
  const line = Math.min(doc.lineCount - 1, Math.max(0, current + randInt(-8, 8)));
  const col = randInt(0, doc.lineAt(line).text.length);
  const pos = new vscode.Position(line, col);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
}

// Scrolls in several small steps, like a mouse wheel, and now and then by a
// whole page. Keeps one direction per burst.
async function scroll(id) {
  if (!vscode.window.activeTextEditor) return;
  const to = Math.random() < 0.5 ? 'up' : 'down';
  if (Math.random() < 0.2) {
    await vscode.commands.executeCommand('editorScroll', { to, by: 'page', value: 1, revealCursor: false });
    return;
  }
  const steps = randInt(3, 10);
  for (let i = 0; i < steps; i++) {
    if (id !== runId) return;
    await vscode.commands.executeCommand('editorScroll', {
      to,
      by: 'line',
      value: randInt(1, 3),
      revealCursor: false,
    });
    await sleep(randInt(60, 220));
  }
}

// Finds a word on a line near the cursor. Returns undefined if there is none.
function pickWord(editor) {
  const doc = editor.document;
  const current = editor.selection.active.line;
  for (let attempt = 0; attempt < 12; attempt++) {
    const line = Math.min(doc.lineCount - 1, Math.max(0, current + randInt(-15, 15)));
    const matches = [...doc.lineAt(line).text.matchAll(/[A-Za-z_]\w{2,}/g)];
    if (!matches.length) continue;
    const m = matches[randInt(0, matches.length - 1)];
    return { line, start: m.index, end: m.index + m[0].length, word: m[0] };
  }
  return undefined;
}

// Selects a whole word, as a double-click would.
async function selectWord() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const w = pickWord(editor);
  if (!w) return;
  const range = new vscode.Range(new vscode.Position(w.line, w.start), new vscode.Position(w.line, w.end));
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// Opens the Find box with a word from the file, steps through a few matches,
// then closes the box. Find only looks; it never replaces anything.
async function search(id) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const w = pickWord(editor);
  if (!w) return;
  await vscode.commands.executeCommand('editor.actions.findWithArgs', {
    searchString: w.word,
    isRegex: false,
    matchWholeWord: false,
    isCaseSensitive: false,
  });
  try {
    const hops = randInt(2, 5);
    for (let i = 0; i < hops; i++) {
      await sleep(randInt(400, 1100));
      if (id !== runId) return;
      await vscode.commands.executeCommand('editor.action.nextMatchFindAction');
    }
    await sleep(randInt(400, 900));
  } finally {
    await vscode.commands.executeCommand('closeFindWidget');
  }
}

async function switchTab() {
  await vscode.commands.executeCommand('workbench.action.nextEditor');
}

// --- opening and closing project files --------------------------------------
// Files come from the workspace folder shown in the Explorer. They are only
// opened for viewing. Only tabs this extension opened itself are ever closed,
// and never a tab with unsaved changes.

const MAX_OPEN_FILES = 4;
const FILE_EXCLUDE = '**/{node_modules,.git,out,dist,build,.vscode-test}/**';
const SKIP_EXT = /\.(png|jpe?g|gif|bmp|ico|webp|pdf|docx?|xlsx?|pptx?|zip|7z|rar|gz|tar|exe|dll|bin|vsix|mp3|mp4|mov|woff2?|ttf|lock)$/i;
const openedByUs = []; // uri strings, oldest first

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

async function closeOneOfOurs() {
  const uriString = openedByUs.shift();
  if (!uriString) return;
  const tab = findTab(uriString);
  if (tab && !tab.isDirty) await vscode.window.tabGroups.close(tab);
}

async function openOrCloseFile() {
  if (openedByUs.length >= MAX_OPEN_FILES || (openedByUs.length && Math.random() < 0.4)) {
    return closeOneOfOurs();
  }
  const files = await vscode.workspace.findFiles('**/*', FILE_EXCLUDE, 500);
  const candidates = files.filter((u) => !SKIP_EXT.test(u.path) && !findTab(u.toString()));
  for (let attempt = 0; attempt < 5 && candidates.length; attempt++) {
    const [uri] = candidates.splice(randInt(0, candidates.length - 1), 1);
    let doc;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      continue; // binary or unreadable, try another one
    }
    await vscode.window.showTextDocument(doc, { preview: false });
    openedByUs.push(uri.toString());
    return;
  }
}

async function closeAllOfOurs() {
  while (openedByUs.length) await closeOneOfOurs();
}

// --- commands --------------------------------------------------------------

function start() {
  if (running) return;
  running = true;
  runId++;
  render();
  scheduleSelectScroll();
  scheduleNext();
}

async function stop() {
  if (!running) return;
  running = false;
  runId++;
  clearTimeout(timer);
  clearTimeout(selectScrollTimer);
  timer = undefined;
  selectScrollTimer = undefined;
  render();
  try {
    await closeAllOfOurs();
  } catch (err) {
    console.error('[auto-activity]', err);
  }
}

function toggle() {
  return running ? stop() : start();
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'autoActivity.toggle';
  render();

  context.subscriptions.push(
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
