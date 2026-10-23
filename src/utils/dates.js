const { limits } = require('../config/extraction');

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: limits.timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const hourFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: limits.timeZone,
  hour: '2-digit',
  hourCycle: 'h23',
});

/** 'yyyy-MM-dd' no fuso de São Paulo */
function localDay(date = new Date()) {
  return dayFormatter.format(date);
}

/** Hora (0-23) no fuso de São Paulo */
function localHour(date = new Date()) {
  return Number(hourFormatter.format(date));
}

module.exports = { localDay, localHour };
