import * as functions from 'firebase-functions';
import axios from 'axios';
import { firestore } from 'firebase-admin';
import { flatten } from 'flatten-anything'
require('firebase-admin').initializeApp();
import { IncomingWebhook, IncomingWebhookSendArguments } from '@slack/webhook';
import { HeaderBlock, SectionBlock } from '@slack/types';


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
  deleted: boolean
}

type MemberReportEntry = {
  name: string
  id: number
  stars: number
  local_score: number
}

type Report = {
  time: Date
  members: Array<MemberReportEntry>
}

const collection_name = "members_2021"
const reports_name = "reports_2021"

export const generateReport = functions.pubsub.schedule('5 */2 * * *').onRun(async (context: functions.EventContext) => {
  const firestoreClient = firestore()

  // get non-deleted members
  const members = await firestoreClient.collection(collection_name).listDocuments()
  const activeMembers: Array<MemberDoc> = []
  for (const doc of members) {
    const docSnapshot = await doc.get()
    const docData = docSnapshot.data() as MemberDoc
    if (!docData.deleted) {
      activeMembers.push(docData)
    }
  }

  // create report obj for each
  const memberReports: Array<MemberReportEntry> = []
  for (const member of activeMembers) {
    memberReports.push({
      name: member.name,
      id: member.id,
      local_score: member.local_score,
      stars: member.stars
    })
  }
  // create report
  const report: Report = {
    time: new Date(),
    members: memberReports
  }
  await firestoreClient.collection(reports_name).add(report)
})

/**
 * Call the api and then go through all the member documents in the collection updating if they're deleted or not
 */
export const flagDeleted = functions.pubsub.schedule('3 */2 * * *').onRun(async (context: functions.EventContext): Promise<void> => {
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

  const ids: string[] = []
  for (const key of Object.keys(data.members)) {
    if (!ids.includes(key)) {
      ids.push(key)
    }
  }

  const firestoreClient = firestore()

  const members = await firestoreClient.collection(collection_name).get()
  for (const doc of members.docs) {
    const docData = doc.data() as MemberDoc
    if (!ids.includes(docData.id.toString())) {
      await doc.ref.update({
        deleted: true
      })
    } else {
      await doc.ref.update({
        deleted: false
      })
    }
  }
})

/**
 * Update the firestore database from the api
 */
export const pollAPI = functions.pubsub.schedule('0 */2 * * *').onRun(async (context: functions.EventContext): Promise<void> => {
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
  const apiMembers: Array<MemberDoc> = []
  const updatedMembers: Array<{
    name: string
    newStars: number
  }> = []

  const memberHandlers: Array<Promise<void>> = []
  for (const [id, member] of Object.entries(data.members)) {
    memberHandlers.push(new Promise(async (resolve) => {
      const memberDoc = await firestoreClient.doc(collection_name + "/" + id).get()
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
        completion,
        deleted: false
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
        if (i === newMembers.length - 1) {
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

export const sendReport = functions.pubsub.schedule('7 23 * * *').onRun(async (context: functions.EventContext) => {
  const firestoreClient = firestore()

  // get latest report
  const latestReport = await firestoreClient.collection(reports_name).orderBy('time', 'desc').limit(1).get()
  const reportData = latestReport.docs[0].data() as Report

  reportData.members.sort((a, b) => b.local_score - a.local_score)

  const header: HeaderBlock = {
    type: 'header',
    text: {
      type: 'plain_text',
      text: ":randy_christmas: Randy's Nice List :randy_christmas:",
      emoji: true
    }
  }

  let membersText: string = ``
  reportData.members.forEach((member, i) => {
      switch (i + 1) {
        case 1:
          membersText += ':first_place_medal:  '
          break
        case 2:
          membersText += ':second_place_medal:  '
          break
        case 3:
          membersText += ':third_place_medal:  '
          break
        default:
          membersText += ':christmas_tree:  '
          break

      }
      membersText += `*${member.name}* (points: ${member.local_score}, stars: ${member.stars})\n`
  });

  const body: SectionBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: membersText
    }
  }

  const webhookPayload: IncomingWebhookSendArguments = {blocks: [header, body]}
  
  const webhook = new IncomingWebhook(functions.config().slack.url)

  await webhook.send(webhookPayload)
})