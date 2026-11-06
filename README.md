# Combination Tracker

Track which of the 10,000 four-digit combinations (0000–9999) you've tried, and see which one you're on now.

## Run
Open `index.html` in a browser. There's nothing to install. Progress saves automatically in the browser's local storage.

## Features
- Four rolling dials (0–9). Click ▲/▼, scroll the mouse wheel over a dial, or click the digit above or below the centre.
- **Tried – Next** (Enter/Space) marks the current combination as tried and jumps to the next untried one.
- Prev/Next (←/→), Toggle tried (T), Next untried (N), Undo (Ctrl+Z), and jump to any code.
- **It worked!** saves the winning combination.
- **Smart order:** tries likely human-chosen codes first: your own meaningful numbers and their digit rearrangements, common codes, repeats and sequences, patterns, years, then dates. You can switch to plain sequential order (0000 → 9999).
- **Clues:** mark each dial's digit as known or ruled out, and list digits the code definitely contains. Everything that doesn't fit is skipped, and the panel shows how much smaller the search space is.
- An **Up next** queue, a label showing why the current code is suggested, and a worst-case time estimate.
- Progress ring, counts of tried and remaining, attempts this session and attempts per minute.
- A 100×100 map of all combinations. Ruled-out cells are dimmed. Click any cell to jump to it. Progress bars for each first digit (0xxx–9xxx).
- History of recent attempts. Click one to jump back to it.
- Export or import progress as JSON, so you can back it up or move it to another browser.
