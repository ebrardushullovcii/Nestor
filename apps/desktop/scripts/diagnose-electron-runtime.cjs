/* eslint-env node */
const electron = require('electron')

console.log('process.versions.electron', process.versions.electron)
console.log('typeof electron', typeof electron)
console.log('electron keys', electron && typeof electron === 'object' ? Object.keys(electron).slice(0, 20) : electron)

if (electron?.app) {
  console.log('app.whenReady type', typeof electron.app.whenReady)
}

process.exit(0)
