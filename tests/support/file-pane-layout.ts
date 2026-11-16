import { expect, type Locator } from '@playwright/test';

/** Check rendered geometry; these rules must hold for built CSS, not just DOM classes. */
export async function assertFilePaneLayout(workspace: Locator, split = false): Promise<void> {
  await expect
    .poll(() =>
      workspace.evaluate((root, both) => {
        const issues: string[] = [];
        const panes = [...root.querySelectorAll<HTMLElement>('.file-pane')];
        const tableTops: number[] = [];
        for (const pane of panes) {
          const name = pane.getAttribute('aria-label');
          const filter = pane.querySelector<HTMLElement>('.file-keyword-filter')!;
          const input = filter.querySelector('input')!;
          const apply = filter.querySelector('button')!;
          const filterBox = filter.getBoundingClientRect();
          if (getComputedStyle(filter).display !== 'flex' || filterBox.height > 28)
            issues.push(`${name}: keyword filter stacks`);
          for (const child of [input, apply]) {
            const box = child.getBoundingClientRect();
            if (box.top < filterBox.top || box.bottom > filterBox.bottom)
              issues.push(`${name}: keyword control escapes its row`);
          }
          for (const tools of pane.querySelectorAll<HTMLElement>(
            '.file-path-tools, .file-pane-actions',
          )) {
            if (tools.scrollHeight > tools.clientHeight + 1)
              issues.push(
                `${name}: ${tools.classList[0]} clips controls vertically (${tools.scrollHeight}/${tools.clientHeight})`,
              );
          }
          const table = pane.querySelector<HTMLElement>('.file-table');
          if (!table) continue;
          tableTops.push(table.getBoundingClientRect().top);
          const header = table.querySelector<HTMLElement>('.file-table-header')!;
          const columns = [...header.children].map((cell) => cell.getBoundingClientRect());
          const scroll = table.querySelector<HTMLElement>('.file-table-scroll')!;
          for (const row of table.querySelectorAll<HTMLElement>('.file-row')) {
            const box = row.getBoundingClientRect();
            if (Math.abs(box.width - scroll.clientWidth) > 1 || box.height !== 32)
              issues.push(`${name}: file row does not fill the grid`);
            [...row.children].forEach((cell, index) => {
              const cellBox = cell.getBoundingClientRect();
              if (
                Math.abs(cellBox.left - columns[index]!.left) > 1 ||
                Math.abs(cellBox.width - columns[index]!.width) > 1
              )
                issues.push(
                  `${name}: column ${index} is misaligned: row ${cellBox.left}/${cellBox.width}, header ${columns[index]!.left}/${columns[index]!.width}`,
                );
            });
          }
        }
        if (both && tableTops.length === 2 && Math.abs(tableTops[0]! - tableTops[1]!) > 1)
          issues.push('Local and remote tables start at different heights');
        return issues;
      }, split),
    )
    .toEqual([]);
}
