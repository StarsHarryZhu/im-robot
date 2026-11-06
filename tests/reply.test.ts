import { describe, expect, it } from 'vitest'
import { KEEP_MAX_CHARS, splitReply, stripMarkdown } from '../src/reply.ts'

describe('stripMarkdown', () => {
  it('drops headings, emphasis, code markers, quotes, rules, and images', () => {
    expect(stripMarkdown('# 标题\n###### Small\n\n**粗体** and *italic* and ***both*** and __b__ and _i_ and ~~gone~~')).toBe(
      '标题\nSmall\n\n粗体 and italic and both and b and i and gone',
    )
    expect(stripMarkdown('> 引用一\n> > 引用二\n\n---\n\n文字 ![图](https://x/y.png) 继续')).toBe('引用一\n引用二\n\n文字  继续')
    expect(stripMarkdown('用 `npm test` 跑')).toBe('用 npm test 跑')
  })

  it('keeps fenced code content without the fences', () => {
    expect(stripMarkdown('看：\n```js\nconst a = **1**\n```\n完')).toBe('看：\nconst a = **1**\n完')
  })

  it('turns lists, links, and tables into plain text', () => {
    expect(stripMarkdown('- 一\n* 二\n+ 三\n  - 四\n- [x] 完成\n1. 第一')).toBe('· 一\n· 二\n· 三\n  · 四\n· 完成\n1. 第一')
    expect(stripMarkdown('[文档](https://a.b/c) 和 [https://a.b](https://a.b)')).toBe('文档 (https://a.b/c) 和 https://a.b')
    expect(stripMarkdown('| 药 | 时间 |\n| --- | :---: |\n| 降压药 | 8:00 |')).toBe('药  时间\n降压药  8:00')
  })

  it('leaves ordinary text, snake_case words, and arithmetic alone', () => {
    expect(stripMarkdown('file_name_here 和 2 * 3 * 4 = 24')).toBe('file_name_here 和 2 * 3 * 4 = 24')
    expect(stripMarkdown('a\r\nb\n\n\n\nc')).toBe('a\nb\n\nc')
  })
})

describe('splitReply', () => {
  it('keeps short text whole and drops empty input', () => {
    expect(splitReply('  你好  ', 10)).toEqual(['你好'])
    expect(splitReply('   ', 10)).toEqual([])
  })

  it('prefers paragraph, then line, then sentence breaks', () => {
    expect(splitReply('第一段第一段\n\n第二段第二段', 10)).toEqual(['第一段第一段', '第二段第二段'])
    expect(splitReply('一行一行一行\n二行二行二行', 10)).toEqual(['一行一行一行', '二行二行二行'])
    expect(splitReply('Hello there. General Kenobi!', 16)).toEqual(['Hello there.', 'General Kenobi!'])
  })

  it('cuts hard when there is no break, never inside a surrogate pair', () => {
    expect(splitReply('abcdefghijklmnop', 5)).toEqual(['abcde', 'fghij', 'klmno', 'p'])
    const emoji = 'ab😀cd'
    const parts = splitReply(emoji, 3)
    expect(parts.join('')).toBe(emoji)
    expect(parts.every(part => !/[\uD800-\uDBFF]$/u.test(part))).toBe(true)
    expect(splitReply('😀😀', 1).join('')).toBe('😀😀')
  })

  it('prefers a sentence end to a later comma, and a comma to a hard cut', () => {
    const sentence = `${'甲'.repeat(59)}。${'乙'.repeat(30)}，${'丙'.repeat(30)}`
    expect(splitReply(sentence, 100)[0]).toBe(`${'甲'.repeat(59)}。`)
    const commas = `${'甲'.repeat(40)}，${'乙'.repeat(40)}，${'丙'.repeat(40)}`
    expect(splitReply(commas, 100)).toEqual([`${'甲'.repeat(40)}，${'乙'.repeat(40)}，`, '丙'.repeat(40)])
    expect(splitReply('甲'.repeat(150), 100)).toEqual(['甲'.repeat(100), '甲'.repeat(50)])
  })

  it('knows the commas and full stops of several scripts', () => {
    const cases: [string, string][] = [
      [`${'あ'.repeat(8)}、${'い'.repeat(8)}`, `${'あ'.repeat(8)}、`],
      [`${'あ'.repeat(8)}。${'い'.repeat(8)}`, `${'あ'.repeat(8)}。`],
      [`${'ب'.repeat(8)}، ${'ت'.repeat(8)}`, `${'ب'.repeat(8)}،`],
      [`${'ب'.repeat(8)}؟ ${'ت'.repeat(8)}`, `${'ب'.repeat(8)}؟`],
      [`${'क'.repeat(8)}। ${'ख'.repeat(8)}`, `${'क'.repeat(8)}।`],
      ['Alpha beta, gamma delta', 'Alpha beta,'],
      ['Alpha beta; gamma delta', 'Alpha beta;'],
      ['Alpha beta! Gamma delta', 'Alpha beta!'],
    ]
    for (const [text, first] of cases) expect(splitReply(text, 14)[0], text).toBe(first)
  })

  it('keeps closing quotes with their sentence', () => {
    expect(splitReply('他说：“明天早上八点吃药。”然后就睡了，晚安。', 16)[0]).toBe('他说：“明天早上八点吃药。”')
    expect(splitReply('She said "fine." Then she left the room.', 20)[0]).toBe('She said "fine."')
  })

  it('never cuts inside numbers, times, or links', () => {
    expect(splitReply('Pi is 3.14159 and the rest follows', 16)).toEqual(['Pi is 3.14159', 'and the rest', 'follows'])
    expect(splitReply('It costs 1,000 yuan at 10:30 today', 16)).toEqual(['It costs 1,000', 'yuan at 10:30', 'today'])
    expect(splitReply('看 https://a.b/c?x=1,2 这里', 20)).toEqual(['看', 'https://a.b/c?x=1,2', '这里'])
    expect(splitReply('看 https://a.b/c?x=1,2 这里', 10)[1]).toBe('https://a.')
  })

  it('counts characters, so an emoji is one', () => {
    expect(splitReply('😀'.repeat(5), 5)).toEqual(['😀'.repeat(5)])
    expect(splitReply('😀'.repeat(6), 5)).toEqual(['😀'.repeat(5), '😀'])
  })

  it('keeps a marked block in one segment, past the limit, and drops the markers', () => {
    const text = '说明：<keep>\n1. 早上吃药\n2. 中午散步\n3. 晚上早睡\n</keep>好的。'
    expect(splitReply(text, 10)).toEqual(['说明：', '1. 早上吃药\n2. 中午散步\n3. 晚上早睡', '好的。'])
  })

  it('lets a marked block share a segment with the text around it when everything fits', () => {
    expect(splitReply('今天安排：\n<keep>1. 吃药\n2. 散步</keep>\n就这些。', 100)).toEqual(['今天安排：\n1. 吃药\n2. 散步\n就这些。'])
    expect(splitReply('第一句很长很长很长。<keep>表：甲乙丙</keep>第二句也长长长长。', 20))
      .toEqual(['第一句很长很长很长。表：甲乙丙', '第二句也长长长长。'])
  })

  it('never splits text before a block through the block', () => {
    const parts = splitReply(`${'前'.repeat(15)}。${'前'.repeat(15)}。<keep>${'表'.repeat(12)}</keep>`, 20)
    expect(parts).toEqual([`${'前'.repeat(15)}。`, `${'前'.repeat(15)}。`, '表'.repeat(12)])
  })

  it('splits a block only when it is longer than the cap, at the cap', () => {
    expect(KEEP_MAX_CHARS).toBe(2000)
    const block = Array.from({ length: 6 }, (_, index) => `第${index}行内容`).join('\n')
    expect(splitReply(`<keep>${block}</keep>`, 10, 20)).toEqual(['第0行内容\n第1行内容\n第2行内容', '第3行内容\n第4行内容\n第5行内容'])
  })

  it('tolerates sloppy markers', () => {
    expect(splitReply('A <KEEP>b c</Keep> d', 100)).toEqual(['A b c d'])
    expect(splitReply('A < keep >b c< / keep > d', 100)).toEqual(['A b c d'])
    expect(splitReply('stray</keep> closer', 100)).toEqual(['stray closer'])
    expect(splitReply('<keep>outer <keep>inner</keep> tail', 6)).toEqual(['outer inner', 'tail'])
    expect(splitReply('甲。<keep>乙乙乙乙乙乙乙乙', 5)).toEqual(['甲。', '乙乙乙乙乙乙乙乙'])
    expect(splitReply('<keep></keep>  ', 10)).toEqual([])
  })

  it('never exceeds the limit on long mixed text', () => {
    const text = Array.from({ length: 40 }, (_, index) => `第${index}句话，内容有点长。`).join('')
    const parts = splitReply(text, 50)
    expect(parts.every(part => part.length <= 50)).toBe(true)
    expect(parts.join('')).toBe(text)
  })
})
