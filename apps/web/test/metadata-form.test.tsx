/**
 * MetadataForm 渲染器测试。
 *
 * 这个文件证明「界面上点得对」：6 种控件都渲染出**带标签、可访问**的控件、
 * group 读写正确、清空一个字段在补丁里变成 null。
 * 「算得对」（diffMetadata 的三条规则）在 `asset-metadata.test.ts` 里单独测 ——
 * 纯逻辑与渲染分开，出错时能一眼看出是哪一层。
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MetadataForm } from '../src/features/assets/metadata/MetadataForm.js';
import { diffMetadata, type FieldSpec } from '../src/features/assets/metadata/specs.js';

/** 一份小字段表：6 种控件各一个，便于逐个断言 */
const SPECS: readonly FieldSpec[] = [
  { kind: 'text', key: 'slogan', label: '品牌口号' },
  { kind: 'textarea', key: 'tone', label: '品牌调性', help: 'Agent 写文案前会读这一段' },
  { kind: 'number', key: 'heightCm', label: '身高（厘米）' },
  {
    kind: 'select',
    key: 'gender',
    label: '性别气质',
    options: [
      { value: 'male', label: '男' },
      { value: 'female', label: '女' },
    ],
  },
  { kind: 'tags', key: 'colors', label: '品牌色' },
  {
    kind: 'group',
    key: 'appearance',
    label: '外观',
    fields: [{ kind: 'text', key: 'hair', label: '发型发色' }],
  },
];

/**
 * 受控宿主：把 onChange 接起来，并提供一个「保存」按钮把 `diffMetadata`
 * 的结果交出来 —— 与真实调用方（创建对话框 / 详情抽屉）的用法一致。
 */
function Host({
  initial = {},
  onPatch,
}: {
  initial?: Record<string, unknown>;
  onPatch?: (patch: Record<string, unknown>) => void;
}) {
  const [value, setValue] = useState<Record<string, unknown>>(initial);
  return (
    <>
      <MetadataForm specs={SPECS} value={value} onChange={setValue} idPrefix="t" />
      <button
        type="button"
        onClick={() => {
          onPatch?.(diffMetadata(SPECS, initial, value));
        }}
      >
        保存
      </button>
    </>
  );
}

describe('MetadataForm 的 6 种控件', () => {
  it('每种控件都渲染出带中文标签的控件', () => {
    render(<Host />);

    expect(screen.getByLabelText('品牌口号')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('品牌调性').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('身高（厘米）')).toHaveAttribute('type', 'number');

    const gender = screen.getByLabelText('性别气质');
    expect(gender.tagName).toBe('SELECT');
    expect(within(gender).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '未设置',
      '男',
      '女',
    ]);

    // tags 的输入框与其它文本控件同一个外观，但提交语义是数组
    expect(screen.getByLabelText('品牌色')).toHaveAttribute('type', 'text');

    // group 渲染成 fieldset + legend：读屏用户能听到分组名
    expect(screen.getByRole('group', { name: '外观' })).toBeInTheDocument();
  });

  it('说明文字通过 aria-describedby 挂在控件上，而不是只显示在旁边', () => {
    render(<Host />);
    const tone = screen.getByLabelText('品牌调性');
    const describedBy = tone.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? '')).toHaveTextContent(
      'Agent 写文案前会读这一段',
    );
  });

  it('数字控件写回的是 number，不是字符串', async () => {
    const onPatch = vi.fn();
    render(<Host onPatch={onPatch} />);
    await userEvent.type(screen.getByLabelText('身高（厘米）'), '168');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onPatch).toHaveBeenCalledWith({ heightCm: 168 });
  });

  it('清空一个原本有值的字段 → 补丁里是 null', async () => {
    const onPatch = vi.fn();
    render(<Host initial={{ slogan: '原来有口号' }} onPatch={onPatch} />);
    await userEvent.clear(screen.getByLabelText('品牌口号'));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onPatch).toHaveBeenCalledWith({ slogan: null });
  });

  it('下拉选「未设置」→ 已设过的值被清成 null', async () => {
    const onPatch = vi.fn();
    render(<Host initial={{ gender: 'male' }} onPatch={onPatch} />);
    await userEvent.selectOptions(
      screen.getByLabelText('性别气质'),
      screen.getByRole('option', { name: '未设置' }),
    );
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onPatch).toHaveBeenCalledWith({ gender: null });
  });

  it('group 内清空发嵌套 null，绝不把整个 group 置 null', async () => {
    const onPatch = vi.fn();
    render(<Host initial={{ appearance: { hair: '黑色长直发', age: 22 } }} onPatch={onPatch} />);
    await userEvent.clear(screen.getByLabelText('发型发色'));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    // 发 { appearance: null } 会把 Agent 写入的 age 一起删掉
    expect(onPatch).toHaveBeenCalledWith({ appearance: { hair: null } });
  });

  it('group 内的编辑不会把顶层其它键挤掉（递归渲染必须重新套回 group 键）', async () => {
    const onPatch = vi.fn();
    render(<Host initial={{ slogan: '原来有口号', appearance: { age: 22 } }} onPatch={onPatch} />);
    await userEvent.type(screen.getByLabelText('发型发色'), '黑色长直发');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    // 写回时若忘了把子对象套回 `appearance` 键，metadata 会被整个替换成
    // `{ hair: … }`，于是这里会看到 { slogan: null } 这种「什么都没改却全丢了」
    expect(onPatch).toHaveBeenCalledWith({ appearance: { hair: '黑色长直发' } });
  });

  it('提交中禁用全部控件，避免改到一半又被提交一次', () => {
    render(
      <MetadataForm specs={SPECS} value={{}} onChange={() => undefined} disabled idPrefix="t" />,
    );
    expect(screen.getByLabelText('品牌口号')).toBeDisabled();
    expect(screen.getByLabelText('品牌调性')).toBeDisabled();
    expect(screen.getByLabelText('性别气质')).toBeDisabled();
    expect(screen.getByLabelText('品牌色')).toBeDisabled();
  });

  it('字段级错误显示在对应输入框下面，而不是只堆在页面顶部', () => {
    render(
      <MetadataForm
        specs={SPECS}
        value={{}}
        onChange={() => undefined}
        errors={{ 'appearance.hair': '字符串长度不能超过 200' }}
        idPrefix="t"
      />,
    );
    const hair = screen.getByLabelText('发型发色');
    expect(hair).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('字符串长度不能超过 200');
  });
});

describe('MetadataForm 的 tags 控件', () => {
  it('回车添加一项，点 × 删除一项', async () => {
    render(<Host />);
    const input = screen.getByLabelText('品牌色');

    await userEvent.type(input, '#1F6FEB{Enter}');
    expect(screen.getByText('#1F6FEB')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '删除 #1F6FEB' }));
    expect(screen.queryByText('#1F6FEB')).not.toBeInTheDocument();
  });

  it('输入后直接点保存（没按回车）也会带上这一项 —— 失焦即提交', async () => {
    const onPatch = vi.fn();
    render(<Host onPatch={onPatch} />);
    await userEvent.type(screen.getByLabelText('品牌色'), '#0B5FFF');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onPatch).toHaveBeenCalledWith({ colors: ['#0B5FFF'] });
  });

  it('逗号也当分隔符（中文输入法下用户会打「，」）', async () => {
    const onPatch = vi.fn();
    render(<Host onPatch={onPatch} />);
    await userEvent.type(screen.getByLabelText('品牌色'), '#1F6FEB,#0B5FFF');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onPatch).toHaveBeenCalledWith({ colors: ['#1F6FEB', '#0B5FFF'] });
  });

  it('重复项不会被加第二次', async () => {
    render(<Host initial={{ colors: ['#1F6FEB'] }} />);
    await userEvent.type(screen.getByLabelText('品牌色'), '#1F6FEB{Enter}');
    expect(screen.getAllByText('#1F6FEB')).toHaveLength(1);
  });

  it('加过又删掉 → 提交空数组（明确表达「清空」），而不是 null', async () => {
    const onPatch = vi.fn();
    render(<Host initial={{ colors: ['#1F6FEB'] }} onPatch={onPatch} />);
    await userEvent.click(screen.getByRole('button', { name: '删除 #1F6FEB' }));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    // 数组是**整体替换**语义：空数组才是「一个都不剩」，null 会被 schema 拒掉
    expect(onPatch).toHaveBeenCalledWith({ colors: [] });
  });
});
