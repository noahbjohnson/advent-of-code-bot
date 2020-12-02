import * as functions from 'firebase-functions';
import axios from 'axios';
import { firestore } from 'firebase-admin';
import { flatten } from 'flatten-anything'
require('firebase-admin').initializeApp();
import { IncomingWebhook } from '@slack/webhook';

interface Imember {
  name: string
  completion_day_level: {
    [day: string]: {
      [star: string]: {
        get_star_ts: string
      }
    }
  }
  last_star_ts: string | 0
  id: string
  stars: number
  local_score: number
  global_score: number
}

type Completion = {
  [day: number]: { [star: number]: Date }
};

type MemberDoc = {
  name: string
  last_star: Date
  id: number
  stars: number
  local_score: number
  global_score: number
  completion: Completion
}

export const pollAPI = functions.pubsub.schedule('every 15 minutes').onRun(async (context: functions.EventContext): Promise<void> => {
  console.log('checking API')
  const response = await axios.create({
    headers: {
      "Cookie": functions.config().advent.cookie
    }
  }).get(`https://adventofcode.com/${functions.config().advent.year}/leaderboard/private/view/${functions.config().advent.team}.json`)
  if (response.status > 200) {
    console.error("error in calling advent server", response)
    throw new Error(response.statusText)
  }

  const data = response.data as {
    members: { [key: string]: Imember }
    owner_id: string
    event: string
  }

  const firestoreClient = firestore()
  const webhook = new IncomingWebhook(functions.config().slack.url);

  const newMembers: Array<MemberDoc> = []
  const apiMembers : Array<MemberDoc> = []
  const updatedMembers: Array<{
    name: string
    newStars: number
  }> = []

  const memberHandlers: Array<Promise<void>> = []
  for (const [id, member] of Object.entries(data.members)) {
    memberHandlers.push(new Promise(async (resolve) => {
      const memberDoc = await firestoreClient.doc("members/" + id).get()
      const { stars, local_score, global_score, name } = member

      const completion: Completion = {}
      Object.keys(member.completion_day_level).forEach(d => {
        const day = parseInt(d)
        completion[day] = {}

        Object.keys(member.completion_day_level[d]).forEach(s => {
          const date = member.completion_day_level[d][s].get_star_ts
          completion[day][parseInt(s)] = new Date(parseInt(date) * 1000)
        })

      })

      const docData: MemberDoc = {
        name,
        last_star: member.last_star_ts ? new Date(parseInt(member.last_star_ts) * 1000) : new Date(member.last_star_ts),
        id: parseInt(member.id),
        stars,
        local_score,
        global_score,
        completion
      }
      apiMembers.push(docData)

      if (memberDoc.exists) {
        const memberData = memberDoc.data() as MemberDoc
        if (memberData.stars < docData.stars) {
          await memberDoc.ref.update(flatten(docData))
          updatedMembers.push({
            name: docData.name,
            newStars: docData.stars - memberData.stars
          })
        }
      } else {
        await memberDoc.ref.set(docData)
        newMembers.push((await memberDoc.ref.get()).data() as MemberDoc)
      }

      resolve()
    }))
  }

  await Promise.all(memberHandlers)

  if (newMembers.length > 0) {
    console.info("one or more new members found")

    let memberString = ""
    newMembers.forEach((member, i) => {
      if (i > 0) {
        memberString += " , "
        if (i === newMembers.length -1){
          memberString += "and "
        }
      }
      memberString += member.name
    })

    console.info("sending new member welcome to slack")
    await webhook.send({
      text: `Please welcome new member${newMembers.length > 1 ? 's' : ''}: ${memberString} to the leaderboard! :wave:`
    })
  } else {
    console.info("no new members")
  }

  if (updatedMembers.length > 0) {
    console.info("one or more updated members found")
    console.log(JSON.stringify(updatedMembers))

    for (const member of updatedMembers) {
      if (member.newStars > 0) {
        console.info(`sending star notification for ${member.name}`)
        await webhook.send({
          text: `:star2: ${member.name} got ${member.newStars > 1 ? `${member.newStars} new stars` : 'a new star'}!`
        })
      }
    }
  } else {
    console.info("no updated members")
  }

  // TODO: leaderboard report
  // TODO: cleanup when a user leaves

})