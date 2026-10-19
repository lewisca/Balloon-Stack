// Assembles the single-file index.html from src/.
const fs = require('fs');
const read = f => fs.readFileSync(__dirname + '/src/' + f, 'utf8');
// sim.js exports itself for Node; the browser build doesn't need that line.
const sim = read('sim.js').replace(/^if \(typeof module !== 'undefined'\).*\n/m, '');
const html = read('head.html') + read('body.html') +
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.19.0/matter.min.js"></script>\n<script>\n' +
  sim + read('game.js') + '</script>\n';
fs.writeFileSync(__dirname + '/index.html', html);
console.log('built index.html');
