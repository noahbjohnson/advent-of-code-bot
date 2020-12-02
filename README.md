# Advent of Code Slackbot for Firebase

## Features

The firebase project deploys a cloud function that will use firestore to keep track of leaderboard changes. It will:

- Send a webhook message when someone joins the leaderboard
- Send a webhook message when someone has completed one or more challenges
- (TODO) Send a webhook shaming people who leave the leaderboard
- (TODO) Send a daily webhook with a leaderboard

## Setup
Should be super easy to deploy:

- Check out
- Set up a firebase project (in the browser console)
- run `firebase init` and select your intented target project
- Add your secrets to `set_env.sh` and run it `sh set_env.sh`
- run `firebase deploy`

## Change interval

Just alter `'every 2 hours'` in [functions/index.ts]() to your desired update interval.