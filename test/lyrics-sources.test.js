const test = require('node:test');
const assert = require('node:assert');
const S = require('../lyrics-sources');

const YRC = [
  '[0,1000](0,1000,0) 作词 : Chris Martin/Guy Berryman',
  '[1000,1000](1000,1000,0) 作曲 : Chris Martin',
  '[33520,2520](33520,420,0)Look (33940,270,0)at (34210,120,0)the (34330,1710,0)stars',
  '[36250,3960](36250,270,0)Look (36520,450,0)how (36970,180,0)they (37150,720,0)shine (37870,1170,0)for (39040,1170,0)you',
  'not a yrc line',
].join('\n');

test('NetEase word-timed lyrics: lines with their words, credits left out', () => {
  const lines = S.parseYrc(YRC);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].text, 'Look at the stars');
  assert.strictEqual(lines[0].start, 33.52);
  assert.deepStrictEqual(lines[0].words[3], { text: 'stars', start: 34.33, end: 36.04 });
  assert.strictEqual(lines[1].words.length, 6);
});

test('NetEase: pieces of one Latin word are glued, CJK characters stand alone', () => {
  const [line] = S.parseYrc('[1000,3000](1000,200,0)Hel(1200,300,0)lo (1500,400,0)世(1900,400,0)界');
  assert.deepStrictEqual(line.words.map(w => w.text), ['Hello', '世', '界']);
  assert.strictEqual(line.words[0].end, 1.5);
});

test('NetEase search: the right song by title, artist and length', () => {
  const songs = [
    { id: 1, name: 'Yellow', duration: 200000, artists: [{ name: 'Coldplay' }] },
    { id: 2, name: 'Yellow Submarine', duration: 266000, artists: [{ name: 'The Beatles' }] },
    { id: 3, name: 'Yellow', duration: 266773, artists: [{ name: 'Coldplay' }] },
  ];
  assert.strictEqual(S.pickNetEaseSong(songs, 'Yellow', 'Coldplay', 267), 3);
  assert.strictEqual(S.pickNetEaseSong(songs, 'Yellow', 'Coldplay', 0), 1);
  assert.strictEqual(S.pickNetEaseSong(songs, 'Fix You', 'Coldplay', 0), null);
  assert.strictEqual(S.pickNetEaseSong(songs, 'Yellow', 'Someone Else', 0), null);
});

test('Genius: lyrics come out of the page, headers and annotations do not', () => {
  const html = '<html><div data-lyrics-container="true"><div data-exclude-from-selection="true">3 Contributors<br>Read More</div>[Verse 1]<br/>Look at the stars<br><a href="x"><span>Look how they shine for you</span></a><br>[Instrumental]<br>It&#x27;s &amp; done</div>'
    + '<p>other</p><div data-lyrics-container="true">Second &quot;part&quot;<br><div>nested</div>end</div></html>';
  assert.strictEqual(S.extractGeniusLyrics(html), 'Look at the stars\nLook how they shine for you\n[Instrumental]\nIt\'s & done\nSecond "part"\nnestedend');
  assert.strictEqual(S.extractGeniusLyrics('<html>no lyrics</html>'), '');
});

test('Genius search: only a hit whose title (and artist) match', () => {
  const hits = [
    { result: { title: 'Yellow (Live)', artist_names: 'Coldplay', url: 'https://genius.com/live' } },
    { result: { title: 'Yellow', artist_names: 'Coldplay', url: 'https://genius.com/Coldplay-yellow-lyrics' } },
    { result: { title: 'Yellow', artist_names: 'Katy Perry', url: 'https://genius.com/other' } },
  ];
  assert.strictEqual(S.pickGeniusHit(hits, 'Yellow', 'Coldplay'), 'https://genius.com/Coldplay-yellow-lyrics');
  assert.strictEqual(S.pickGeniusHit(hits, 'Clocks', 'Coldplay'), null);
  assert.strictEqual(S.pickGeniusHit([{ result: { title: 'Yellow', artist_names: 'Coldplay', url: 'http://evil.example/' } }], 'Yellow', 'Coldplay'), null);
});

test('enhanced LRC: word tags become timed words', () => {
  const words = S.parseEnhancedLrcWords('<00:10.00>Hello <00:10.50>big world<00:12.00>', 14);
  assert.deepStrictEqual(words, [
    { text: 'Hello', start: 10, end: 10.5 },
    { text: 'big', start: 10.5, end: 12 },
    { text: 'world', start: 10.5, end: 12 },
  ]);
  assert.strictEqual(S.parseEnhancedLrcWords('plain line', 4), null);
});

test('word times are lined up with the lyrics on screen, or not used at all', () => {
  const shown = [
    { time: 33.5, text: 'Look at the stars' },
    { time: 36.2, text: 'Look how they shine for you' },
    { time: 40, text: '', isGap: true },
  ];
  const timed = S.parseYrc(YRC);
  const out = S.alignWordTimings(shown, timed);
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0][0].start, 33.52);
  assert.strictEqual(out[1].length, 6);
  assert.strictEqual(out[2], undefined);
  // other lyrics entirely: nothing
  assert.strictEqual(S.alignWordTimings([{ time: 1, text: 'Something else' }, { time: 2, text: 'Entirely different' }], timed), null);
});

test('word times work when the two sites split lines differently and are a little apart', () => {
  // NetEase: one line, 2 s earlier than lrclib's two lines
  const timed = S.parseYrc('[10000,6000](10000,500,0)Hello (10500,500,0)there (12000,500,0)general (12500,1000,0)Kenobi');
  const shown = [{ time: 12, text: 'Hello there' }, { time: 14, text: 'General Kenobi!' }, { time: 18, text: 'Unknown words here' }];
  const out = S.alignWordTimings(shown, timed);
  assert.deepStrictEqual(out[0], [{ text: 'Hello', start: 12, end: 12.5 }, { text: 'there', start: 12.5, end: 13 }]);
  assert.deepStrictEqual(out[1].map(w => w.start), [14, 14.5]);
  assert.strictEqual(out[1][1].text, 'Kenobi!');
  assert.strictEqual(out[2], undefined);
});

test('a word NetEase lacks gets the time between its neighbours', () => {
  const timed = S.parseYrc('[1000,4000](1000,1000,0)one (3000,1000,0)three (4000,1000,0)four');
  const out = S.alignWordTimings([{ time: 1, text: 'one two three four' }], timed);
  assert.deepStrictEqual(out[0].map(w => [w.text, w.start, w.end]), [['one', 1, 2], ['two', 2, 3], ['three', 3, 4], ['four', 4, 5]]);
  // too few words found: the line keeps its estimated timing
  assert.strictEqual(S.alignWordTimings([{ time: 1, text: 'one two five six' }], timed), null);
});

test('timed words keep the shown spelling when the counts agree', () => {
  const words = [{ text: 'Yeah', start: 1, end: 2 }, { text: 'they', start: 2, end: 3 }];
  assert.deepStrictEqual(S.timedWords("Yeah' they", words), [{ text: "Yeah'", start: 1, end: 2 }, { text: 'they', start: 2, end: 3 }]);
  assert.deepStrictEqual(S.timedWords('Yeah, they were', words).map(w => w.text), ['Yeah', 'they']);
  assert.strictEqual(S.timedWords('x', []), null);
});

test('karaoke fill follows the word times', () => {
  const words = [{ text: 'ab', start: 0, end: 1 }, { text: 'cd', start: 1, end: 3 }];
  assert.strictEqual(S.timedProgress(words, -1), 0);
  assert.strictEqual(S.timedProgress(words, 0.5), 0.25);
  assert.strictEqual(S.timedProgress(words, 2), 0.75);
  assert.strictEqual(S.timedProgress(words, 9), 1);
});

test('line similarity shrugs off punctuation and a dropped word', () => {
  assert.strictEqual(S.lineSimilarity("Don't stop", 'dont stop!'), 1);
  assert.ok(S.lineSimilarity('Oh look at the stars', 'Look at the stars') >= 0.6);
  assert.ok(S.lineSimilarity('Look at the stars', 'Completely unrelated') < 0.6);
});
