# Auto Activity

Generates editor activity in VS Code on timers.

If the active tab is empty, is not a text file, or nothing is open, it opens a
file from the project folder first, so the timers always have something to act
on. Every action is written to **Output > Auto Activity** with a timestamp.

Every 10-15 seconds:

- selects a whole word near the cursor, then
- scrolls the active editor in small steps (sometimes by a page)

Every 5-20 seconds, one of these at random:

- moves the cursor to a nearby line
- searches for a word with the Find box, steps through matches, then closes it
- opens a file from the project folder shown in the Explorer, or closes one it
  opened earlier (only tabs it opened itself, never one with unsaved changes)
- optionally switches to the next tab (off by default)

Mouse (Windows only), in sessions of 10-15 seconds with a 5-20 second pause
between them:

- moves the real mouse pointer to nearby points along curved, eased paths,
  sometimes overshooting a little and correcting
- only moves the pointer: it never clicks and never presses a key
- stops the session as soon as you move the mouse yourself
- by default does nothing while the VS Code window is not focused

It uses a hidden PowerShell process that calls `user32.dll`, so there is
nothing extra to install. The process ends when you stop Auto Activity.

## It never creates, saves or edits

There is no save, create or edit call anywhere in the code. Every action only
looks at files that already exist.

## Use

Click the icon in the status bar (bottom right) to start, and click again to
stop. Shortcuts: `Ctrl+Alt+Shift+A` toggles, `Ctrl+Alt+Shift+S` starts and
`Ctrl+Alt+Shift+X` stops. The same actions are in the Command
Palette: `Auto Activity: Start`, `Stop` and `Toggle`.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `autoActivity.selectScrollMinSeconds` | 10 | Shortest wait between select-and-scroll steps |
| `autoActivity.selectScrollMaxSeconds` | 15 | Longest wait between select-and-scroll steps |
| `autoActivity.selectWord` | true | Select a word in that step |
| `autoActivity.scroll` | true | Scroll in that step |
| `autoActivity.minSeconds` | 5 | Shortest wait between the other actions |
| `autoActivity.maxSeconds` | 20 | Longest wait between the other actions |
| `autoActivity.moveCursor` | true | Move the cursor |
| `autoActivity.search` | true | Search with the Find box |
| `autoActivity.openCloseFiles` | true | Open and close project files |
| `autoActivity.switchTabs` | false | Switch to the next tab |
| `autoActivity.moveMouse` | true | Move the mouse pointer (Windows only) |
| `autoActivity.mouseSessionMinSeconds` | 10 | Shortest mouse session |
| `autoActivity.mouseSessionMaxSeconds` | 15 | Longest mouse session |
| `autoActivity.mousePauseMinSeconds` | 5 | Shortest pause between mouse sessions |
| `autoActivity.mousePauseMaxSeconds` | 20 | Longest pause between mouse sessions |
| `autoActivity.mousePauseWhenUnfocused` | true | No mouse movement while VS Code is not focused |
| `autoActivity.showStatusBar` | true | Show the status bar icon |
| `autoActivity.startOnLaunch` | false | Start when VS Code opens |

## Try it

Open this folder in VS Code and press `F5`. A second VS Code window opens with
the extension loaded.
