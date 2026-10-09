import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ledger = readFileSync(resolve('docs/implementation/REMAINING_RELEASE_WORK.md'), 'utf8');

describe('independent-release execution ledger', () => {
  it('lists every fixed work item exactly once with an explicit completion mark', () => {
    const items = [...ledger.matchAll(/^- \[([ x])\] \*\*(W-\d{2}-\d{2})｜([^｜]+)｜/gmu)];
    const ids = items.map((item) => item[2]);

    expect(ids).toHaveLength(46);
    expect(new Set(ids).size).toBe(46);
    expect(items.filter((item) => item[1] === 'x').map((item) => item[2])).toEqual([
      'W-03-02',
      'W-04-02',
      'W-08-01',
      'W-09-02',
      'W-13-01',
    ]);
    expect(items.filter((item) => item[1] === 'x')).toHaveLength(5);
    expect(items.filter((item) => item[1] === ' ')).toHaveLength(41);
    expect(items.filter((item) => item[3]?.startsWith('已取消')).map((item) => item[2])).toEqual([
      'W-08-04',
      'W-09-01',
    ]);
    expect(ledger).toContain('**5/46**');
    expect(ledger).toContain('**39 项未完成、2 项由 ADR-021 取消**');
  });

  it('keeps the Mac engineering stop line finite and distinguishes it from release gates', () => {
    const cells = [...ledger.matchAll(/^\| \*\*([SDUT]\d) \/ W-\d{2}-\d{2}\*\* \|/gmu)].map(
      (match) => match[1],
    );

    expect(cells).toEqual([
      'S2',
      'S3',
      'S4',
      'S5',
      'D1',
      'D2',
      'D3',
      'D4',
      'U1',
      'U2',
      'U3',
      'T1',
      'T2',
      'T3',
    ]);
    expect(ledger).toContain('当前指针是 W-14-02 最终源码快照');
    expect(ledger).toContain('**14/14**');
    expect(ledger).toContain('**0/14**');
    expect(ledger).toContain('T2 / W-03-02** | **已过**');
    expect(ledger).toContain('T3 / W-03-02** | **已过**');
    expect(ledger).toContain('T1 / W-03-02** | **已过**');
    expect(ledger).not.toContain('剩余 6 格');
    expect(ledger).not.toContain('还剩 6 格');
    expect(ledger).toContain('其余 10 In progress、2 Open');
    expect(ledger).toContain('不等于签名、公证、权利审定或公开发行');
  });

  it('assigns each of the 46 work items to exactly one principal execution stage', () => {
    const sections = [...ledger.matchAll(/^### 阶段 ([0-5])｜[^\n]+$/gmu)];
    expect(sections.map((match) => Number(match[1]))).toEqual([0, 1, 2, 3, 4, 5]);

    const stageCounts = sections.map((section, index) => {
      const body = ledger.slice(
        section.index,
        sections[index + 1]?.index ?? ledger.indexOf('## 5. 每轮更新'),
      );
      return [...body.matchAll(/^- \[[ x]\] \*\*W-\d{2}-\d{2}｜/gmu)].length;
    });
    expect(stageCounts).toEqual([6, 0, 14, 10, 13, 3]);
  });

  it('keeps next action and close evidence on the same line for every work item', () => {
    const lines = ledger
      .split('\n')
      .filter((line) => /^- \[[ x]\] \*\*W-\d{2}-\d{2}｜/u.test(line));
    expect(lines).toHaveLength(46);
    for (const line of lines) {
      expect(line).toContain('下一步：');
      expect(line).toMatch(/完成(?:证据)?：/u);
    }
  });

  it('keeps the next Mac scope and pending product sign-off explicit', () => {
    expect(ledger).toContain('W-05-02 的产品审查也未签收');
    expect(ledger).toContain('U1 → U2 → U3');
    expect(ledger).toContain('T1 → T2 → T3');
    expect(ledger).toContain('W-05-02 的产品审查也未签收');
    expect(ledger).toContain('W-02-01｜待审');
    expect(ledger).toContain('source:review:reviewed-check 对最终字节通过');
  });

  it('runs actionable work in batches without hiding external dependencies', () => {
    expect(ledger).toContain('取消“每轮只做一格”的人为停顿');
    expect(ledger).toContain('连续完成当前可执行批次');
    expect(ledger).toContain('旧 Axoterm/Axterm 包**未公开分发**');
    expect(ledger).toContain('旧未公开原型 profile 不原位升级');
    expect(ledger).toContain('现行新目录隔离和手动数据退出');
    expect(ledger).toContain('W-06-02、W-08-02、W-13-02 的发行签收仍开放');
    expect(ledger).toContain('不等待公开迁移窗口');
    expect(ledger).not.toContain('迁移窗口达标 → M3');
  });
});
