# Screen art

Drop these files here and the matching screens pick them up automatically.
Each is optional — without one, the screen falls back to its gradient
treatment, which is styled to stand on its own.

| File         | Screen                       | Suggested size |
| ------------ | ---------------------------- | -------------- |
| `splash.jpg` | Title / main menu            | 1920×1080      |
| `busted.jpg` | Pulled over by the patrol    | 1920×1080      |
| `winner.jpg` | Finished 1st                 | 1920×1080      |
| `wasted.jpg` | Health ran out               | 1920×1080      |

A dark scrim goes over the top via CSS, so keep the middle of the frame
readable rather than busy.

These paintings usually have the title lettered into them. The game probes
for each file at boot and, when one loads, hides the screen's own heading —
so a painted "BUSTED!" is not printed over by an HTML one. Remove the file
and the heading comes back.
