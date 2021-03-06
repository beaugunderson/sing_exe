'use strict';

const async = require('async');
const botUtilities = require('bot-utilities');
const cheerio = require('cheerio');
const debug = require('debug')('sing_exe');
const natural = require('natural');
const program = require('commander');
const request = require('request');
const stringSimilarity = require('string-similarity');
const Twit = require('twit');
var _ = require('lodash');

_.mixin(botUtilities.lodashMixins);
_.mixin(Twit.prototype, botUtilities.twitMixins);

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CUSTOM_SEARCH_ID = process.env.GOOGLE_CUSTOM_SEARCH_ID;

const SCREEN_NAME = process.env.SCREEN_NAME || 'sing_exe';

const MUSIC_EMOJI = [
  '💯',
  '🔥',
  '🎙',
  '🎧',
  '🎶',
  '🎵',
  '🎼',
  '🔊',
  '🎤',
  '📻',
  '👌'
];

function getLyrics(url, cb) {
  request.get(url, (err, response, body) => {
    var $ = cheerio.load(body);

    var lyrics = $('.col-xs-12.col-lg-8.text-center > div:not([class])').text();

    var splitLyrics = _.compact(lyrics.split(/[\r\n]+/g))
      .filter(lyric => !lyric.match(/^\[.*\]$/))
      .map(lyric => lyric.replace(/\[[a-z0-9]*\]/gi, ''))
      .map(lyric => lyric.replace(/\s+/g, ' '))
      .map(lyric => lyric.replace(/[´`]/g, "'"))
      .map(lyric => lyric.trim())
      .map(lyric => lyric.toLowerCase());

    cb(err, splitLyrics);
  });
}

function clean(lyric) {
  return (lyric || '' )
    .replace(/^[:;.,\s]+/, '')
    .replace(/[:;,\s]+$/, '');
}

function getNgrams(lyrics, length) {
  return _.flatten(
    lyrics
      .map(line => natural.NGrams.ngrams(line.split(/\s+/g), length, '', '')
      .map(ngram => _.compact(ngram).join(' '))));
}

function lyricRequest(lyric, cb) {
  request.get({
    url: 'https://www.googleapis.com/customsearch/v1',
    qs: {
      q: lyric,
      cx: GOOGLE_CUSTOM_SEARCH_ID,
      key: GOOGLE_API_KEY
    },
    json: true
  }, (err, response, body) => {
    if (err || response.statusCode !== 200 || !body || !body.items) {
      return cb(err || response.statusCode !== 200 ? response.statusCode : null);
    }

    getLyrics(body.items[0].link, cb);
  });
}

function lyricSearch(lyric, cb) {
  // try a quoted search first for more accuracy
  lyricRequest(`"${lyric}"`, (err, lyrics) => {
    if (!err && lyrics && lyrics.length) {
      return cb(err, lyrics);
    }

    lyricRequest(lyric, cb);
  });
}

function completeLyric(lyric, cb) {
  const lyricLower = lyric.toLowerCase();
  const lyricTokens = lyric.split(/\s+/g);

  lyricSearch(lyricLower, (err, lyrics) => {
    if (err || !lyrics || !lyrics.length) {
      return cb(err || new Error(`no lyrics returned for ${lyricLower}`));
    }

    const ngrams = getNgrams(lyrics, lyricTokens.length);

    debug(lyrics);
    debug(ngrams);

    const bestMatches = stringSimilarity.findBestMatch(lyricLower, ngrams);
    const bestMatch = bestMatches.bestMatch.target;

    const matches = _.filter(lyrics, line => line.indexOf(bestMatch) !== -1);
    const match = _.sample(matches);

    debug(match);

    var index = lyrics.indexOf(match);
    var next;

    debug(index);

    if (_.endsWith(match, bestMatch)) {
      next = lyrics[++index];
    } else {
      next = clean(match.slice(match.indexOf(bestMatch) + bestMatch.length).trim());

      if (!next || next.length <= 3) {
        next = lyrics[++index];
      }
    }

    debug(next);

    if (lyrics.length > ++index &&
        (stringSimilarity.compareTwoStrings(lyricLower, next) >= 0.8 ||
         next.length <= 5 ||
         _.random() >= 0.85)) {
      next += `\n${lyrics[index]}`;
    }

    debug(next);
    debug(clean(next));

    cb(err, clean(next));
  });
}

program
  .command('respond')
  .description('Respond to replies')
  .action(() => {
    var T = new Twit(botUtilities.getTwitterAuthFromEnv());

    var stream = T.stream('user');

    stream.on('tweet', tweet => {
      if (!tweet.entities) {
        return;
      }

      const screenNames = _.map(tweet.entities.user_mentions, 'screen_name');

      if (screenNames.indexOf(SCREEN_NAME) === -1) {
        return;
      }

      debug('screenNames %j', screenNames);

      let lyric = tweet.text;

      debug('lyric "%s"', lyric);

      screenNames.forEach(screenName => {
        lyric = lyric.replace(new RegExp(`(?=^|\\W)@${screenName}(?=$|\\W)`, 'gi'), '');
      });

      lyric = lyric.replace(/\s+/g, ' ').trim();

      debug('lyric "%s"', lyric);

      const emoji = _.sample(MUSIC_EMOJI);

      completeLyric(lyric, (err, completedLyric) => {
        if (err || !completedLyric) {
          return console.log(`error: ${err}`);
        }

        const reply = {
          in_reply_to_status_id: tweet.id_str,
          status: `@${tweet.user.screen_name} ${emoji} ${completedLyric} ${emoji} https://twitter.com/${tweet.user.screen_name}/status/${tweet.id_str}`
        };

        T.post('statuses/update', reply, (updateError, data, response) => {
          if (updateError) {
            return console.error('TUWM error', updateError, response.statusCode);
          }

          console.log('statuses/update OK');
        });
      });
    });
  });

program
  .command('test')
  .description('Test the API')
  .action(() => {
    var tests = [
      "ma you're just jealous",
      'i wanna know what love is',
      "i'm too sexy for my shirt",
      'every day is a winding road',
      "i'm a bitch",
      'where is my mind?',
      // sometimes returns '' because it's the last line
      'the microwave had no end',
      'when i first met my'
    ];

    async.eachSeries(tests, (test, cbEach) => {
      console.log(test);

      completeLyric(test, (err, completed) => {
        console.log(err, test, completed);

        cbEach();
      });
    });
  });

program.parse(process.argv);
