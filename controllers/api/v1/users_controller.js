const {
  sendToSlackResponseUrl,
  getSlackUserInfo,
  getSlackImChannel
} = require('../../../helpers/helper_functions');

const jwt = require('jsonwebtoken');
const ApiController = require('./api_controller');
const Timer = require('./timers_controller');

const Team = require('../../../models/team');
const User = require('../../../models/user');
const Answer = require('../../../models/answer');
const Content = require('../../../content');

module.exports = {

  async show (req, res) {

    // authenticate user (user must be signed in)
    const authError = await ApiController.authenticateUser(req);
    if (authError !== null) {
      res.json(authError);    
      return;
    }

    // get requested user info
    const id = parseInt(req.params.id);
    const users = await User.findById(id);

    if (users.length <= 0) {
      const notFoundError = {
        json: {
          type: "Not Found",         
        },
        status: 404
      }
      res.json(notFoundError);       
      return;
    }

    // authorize user (user can only request own data)  
    const auth = req.headers.authorization;
    const payload = jwt.verify(auth, process.env.SECRET);
    const { user_id } = payload;

    if (user_id !== id) {
      const notAuthorized = {
        json: {
          type: "Unauthorized",         
        },
        status: 401
      }
      res.json(notAuthorized);     
      return;
    }

    // get answers
    const answers = await Answer.findAllByUserId(id);

    let count = 0;
    let autonomyTotal = 0;
    let complexityTotal = 0;
    let rewardTotal = 0;

    const runningAvgs = answers.map(answer => {

      count += 1;
      autonomyTotal += answer.autonomy;
      complexityTotal += answer.complexity;
      rewardTotal += answer.reward;

      return {
        autonomy: Math.trunc(autonomyTotal / count * 100),
        complexity: Math.trunc(complexityTotal / count * 100),
        reward: Math.trunc(rewardTotal / count * 100),
        date: answer.date
      };

    });

    const user = users[0];
    const jsonResponse = {
      json: {
        user_name: user.slack_real_name,
        team_name: user.slack_team_name,
        answers: runningAvgs
      },
      status: 200
    };

    res.json(jsonResponse);
  },

  async create (req, res) {

    // private function to parse days and time from user string
    function getDaysAndTime(daysAndTime) {

      // make sure we find a time
      const time = daysAndTime.match(/([1-9]|10|11|12)(:[0-5][0-9])?(am|pm)/i);
      if (!time) {
        return null;
      }

      // check days
      const everyday = daysAndTime.match(/every\s*day/i);
      const weekday = daysAndTime.match(/week\s*day/i);

      const range = daysAndTime.match(/(sun|mon|tues|wednes|thurs|fri|satur)day\s+to\s+(sun|mon|tues|wednes|thurs|fri|satur)day/i);

      const list = daysAndTime.match(/(sun|mon|tues|wednes|thurs|fri|satur)days?((,|,\s+and|\s+and)\s+(sun|mon|tues|wednes|thurs|fri|satur)days?)*/i);

      if (!everyday && !weekday && !range && !list) {
        return null;
      }

      // get hours and minutes
      let hours = parseInt(time[1]);
      const minutes = time[2] !== undefined ? parseInt(time[2].slice(1)) : 0;
      if (time[3] === 'am' && hours === 12) {
        hours = 0;
      }
      else if (time[3] === 'pm' && hours < 12) {
        hours += 12;
      }

      // convert to seconds
      let seconds = (hours * 60 + minutes) * 60;

      // get list of days
      // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
      let days = Array.from({ length: 7 });
      days.fill(false);

      // helper map
      const dayToIndex = { sun: 0, mon: 1, tues: 2, wednes: 3, thurs: 4, fri: 5, satur: 6 };

      if (everyday) {
        days.fill(true);
      }
      else if (weekday) {
        days.fill(true, 1, 6);
      }
      else if (range) {
        const start = dayToIndex[range[1].toLowerCase()];
        const end = dayToIndex[range[2].toLowerCase()] + 1;
        days.fill(true, start, end);
      }
      else if (list) {
        const listStr = list[0].toLowerCase();
        const listArr = listStr.match(/(sun|mon|tues|wednes|thurs|fri|satur)/gi);
        listArr.forEach(day => {
          const index = dayToIndex[day];
          days[index] = true;
        });
      }

      return { days: days, seconds: seconds };
    }


    // private function to convert and save reminders to UTC time
    function setReminders(slackUserId, reminders) {

      // get the user's timezone offset
      return User.getSlackTimezoneOffset(slackUserId)
        .then(tzOffsets => {

          // convert from user time to UTC time
          // slack_tz_offset is in seconds, is negative if behind, positive if ahead
          // so we need to SUBTRACT the client's timezone offset
          reminders = Timer.applyTimezone(reminders, -tzOffsets[0].slack_tz_offset);
          return User.setReminders(slackUserId, reminders);
        })
        .then(() => {
          return new Promise(resolve => {
            resolve(reminders);
          });
        })
        .catch(error => {
          return new Promise(reject => {
            reject(error);
          });
        });
    }

    // private function to convert reminders to a formatted string
    async function getReminderString(slackUserId) {
      try {
        let reminders = await User.getReminders(slackUserId);
        reminders = reminders[0].reminders;

        // if no reminders, return empty string
        if (!reminders) {
          return null;
        }

        // convert the reminders from UTC time back to the client's time
        // slack_tz_offset is in seconds, is negative if behind, positive if ahead
        // so we need to ADD the client's timezone offset
        const tzOffsets = await User.getSlackTimezoneOffset(slackUserId);
        reminders = Timer.applyTimezone(reminders, tzOffsets[0].slack_tz_offset);

        // get which days the client has set reminders
        let reminderArr = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays',
                           'Thursdays', 'Fridays', 'Saturdays'];

        for (let i=reminders.days.length-1; i>=0; i--) {
          if (!reminders.days[i]) {
            reminderArr.splice(i, 1);
          }
        }

        // get the time formatted
        let minutes = reminders.seconds / 60;
        let hours = Math.trunc(minutes / 60);
        minutes = (minutes % 60).toString().padStart(2, '0');

        let amOrPm = 'am';
        if (hours === 0 || hours === 24) {
          hours = 12;
        }
        else if (hours === 12) {
          amOrPm = 'pm';
        }
        else if (hours > 12) {
          hours -= 12;
          amOrPm = 'pm';
        }

        const reminderStr = `${reminderArr.join(', ')} at ${hours}:${minutes} ${amOrPm}`;
        return reminderStr;
      }
      catch(error) {
        return error;
      }
    }


    // Handle slash commands
    // respond with status 200
    res.status(200).end();

    // get request body
    const reqBody = req.body;
    const token = reqBody.token;

    // verify token
    if (token != process.env.SLACK_VERIFICATION_TOKEN) {
      // send error if invalid token
      res.status(403).end('Access Forbidden');
    }
    else {

      // Get slack request
      const { team_id, user_id, response_url } = reqBody;

      try {
        // find the slack team in the database and add new user, or find existing user
        const teams = await Team.findBySlackTeamId(team_id);
        const team = teams[0];
        await User.create(user_id, team.id);

        // save the user's real name and timezone offset
        const userInfo = await getSlackUserInfo(team.slack_bot_access_token, user_id);

        // save the user's im channel
        const channelId = await getSlackImChannel(team.slack_bot_access_token, user_id); 

        const { user } = userInfo;
        const { real_name, tz_offset } = user;
        await User.update(user_id, {
          slack_real_name: real_name,
          slack_tz_offset: tz_offset,
          slack_im_channel_id: channelId
        });

        console.log(`Slack user added successfully: user_id: ${user_id}, channelId: ${channelId}, team_id: ${team_id}`);
      }
      catch(error) {
        console.error(error);
      }
      finally {
        console.log('Slack user added successfully for found existing user');

        // set up response message
        let message = {
          response_type: 'ephemeral'
        };

        // process command arguments
        const args = reqBody.text.trim();
        let firstArg = args;
        let remainingArgs = '';

        const spaceIndex = args.indexOf(' ');
        if (spaceIndex !== -1) {
          firstArg = args.slice(0, spaceIndex);
          remainingArgs = args.slice(spaceIndex).trim();
        }

        switch (firstArg) {
          case 'now':
            try {
              // check if already answered today
              const isDoneToday = await Timer.isDoneToday(user_id);
              if (isDoneToday) {
                console.log('shokubot now: done for today');
                message.text = Content.tryAgain;
              }
              else {
                console.log('shokubot now: sending first question');
                message.text = Content.reminder;
                message.attachments = [
                  {
                    ...Content.autonomy
                  }
                ];
              }
            }
            catch(error) {
              console.error(error);
              message.text = Content.error;
            }
            break;
          case 'remind':
            const reminders = getDaysAndTime(remainingArgs);
            if (reminders !== null) {

              try {
                await setReminders(user_id, reminders);
                await User.setPaused(user_id, false);
                console.log('Reminders saved to the database: ', reminders);

                const dateStr = await Timer.setNextReminder(user_id);
                message.text = `${Content.setReminders} ${Content.nextReminder}${dateStr}.`;

              }
              catch(error) {
                console.error(error);
                message.text = Content.error;
              }
            }
            else {
              message.attachments = [
                {
                  ...Content.remind
                }
              ];
            }
            break;
          case 'pause':
            try {
              // check if there are reminders
              const reminders = await User.getReminders(user_id);
              const remindersObj = reminders[0].reminders;

              if (remindersObj) {
                Timer.cancelReminders(user_id);
                await User.setPaused(user_id, true);
                message.text = Content.pauseReminders;
              }
              else {
                message.text = Content.noReminders;
              }
            }
            catch(error) {
              console.error(error);
              message.text = Content.error;
            }            break;
          case 'unpause':
            try {
              const dateStr = await Timer.setNextReminder(user_id);
              if (dateStr) {
                await User.setPaused(user_id, false);
                message.text = `${Content.unpauseReminders} ${Content.nextReminder}${dateStr}.`;
              }
              else {
                message.text = Content.noReminders;
              }
            }
            catch(error) {
              console.error(error);
              message.text = Content.error;
            }
            break;
          case 'info':
            try {
              const reminderStr = await getReminderString(user_id);
              if (reminderStr) {
                if (Timer.hasReminder(user_id)) {
                  message.text = `${Content.infoActive}${reminderStr}.`;
                }
                else {
                  message.text = `${Content.infoPaused}${reminderStr}.`;
                }
              }
              else {
                message.text = Content.noReminders;
              }
            }
            catch(error) {
              console.error(error);
              message.text = Content.error;
            }
            break;
          default:
            message.attachments = [
              {
                ...Content.help
              }
            ];
        }

        sendToSlackResponseUrl(response_url, message);
      }

    }
  }

}
