#!/bin/sh

export COOKIE=session=fdsafsdsafsdffdsdafsdsfsdf
export TEAM=1234
export YEAR=2020
export WEBHOOK=https://hooks.slack.com/services/secret

firebase functions:config:set slack.url=$WEBHOOK advent.year=$YEAR advent.team=$TEAM advent.cookie=$COOKIE
firebase functions:config:get > functions/.runtimeconfig.json