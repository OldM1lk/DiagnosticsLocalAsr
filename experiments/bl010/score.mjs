import {readFileSync} from 'node:fs';
const [log, metadata] = process.argv.slice(2);
const rows = readFileSync(metadata,'utf8').split(/\r?\n/).map(line=>line.split('|'));
const sources = {'short.wav':'wavs/masha_dima_part9_206.wav','long.wav':'wavs/masha_dima_part12_172.wav'};
const words = text => text.toLowerCase().replaceAll('ё','е').match(/[а-яa-z0-9]+(?:-[а-яa-z0-9]+)*/g) ?? [];
function score(reference, hypothesis) {
  const a = words(reference), b = words(hypothesis);
  const d = Array.from({length:a.length+1},()=>new Uint32Array(b.length+1));
  for (let i=0;i<=a.length;i++) d[i][0]=i;
  for (let j=0;j<=b.length;j++) d[0][j]=j;
  for (let i=1;i<=a.length;i++) for (let j=1;j<=b.length;j++)
    d[i][j]=Math.min(d[i-1][j-1]+Number(a[i-1]!==b[j-1]),d[i-1][j]+1,d[i][j-1]+1);
  const omissions=[], substitutions=[], additions=[];
  let i=a.length,j=b.length;
  while (i || j) {
    if (i && j && d[i][j]===d[i-1][j-1]+Number(a[i-1]!==b[j-1])) {
      if (a[i-1]!==b[j-1]) substitutions.push([a[i-1],b[j-1]]);
      i--; j--;
    } else if (i && d[i][j]===d[i-1][j]+1) omissions.push(a[--i]);
    else additions.push(b[--j]);
  }
  return {wordCount:a.length,omissions:omissions.reverse(),substitutions:substitutions.reverse(),additions:additions.reverse()};
}
for (const run of readFileSync(log,'utf8').trim().split(/\r?\n/).map(JSON.parse)) {
  if (run.cache!=='new-context') continue;
  for (const {file,rawText} of run.rows) {
    const reference=rows.find(row=>row[0]===sources[file])?.[2];
    if (!reference) throw new Error('Нет эталона для '+file);
    console.log(JSON.stringify({model:run.model,file,reference,...score(reference,rawText)}));
  }
}
