import { getCollection } from "../mongo"
import { ObjectId } from "mongodb";
import promclient from "prom-client"
import { messaging } from "firebase-admin";
import moment from "moment";
import { notify as socketNotify } from "../../modules/socket";

export interface Notification 
{
	// Token this notification is addressed to
	token: string,

	// uid of the instigator
	instigator: string,

	// Message of the notificaton
	message: string,

	// Title of the notification
	title: string,

	// When the notification expires
	expireAt: number,

	// Unique Id of the notification
	_id: ObjectId | undefined,
}

export const pollNotifications = async (token:string) : Promise<Notification[]>=> {
	const pendingNotifications = await getCollection("notifications").find({token}).toArray()
	if (pendingNotifications.length > 0)
	{
		const polledNotifications : Array<Notification> = pendingNotifications.map((element) => { return { token: token, instigator: element.instigator, message: element.message, title: element.title, expireAt: element.expireAt, _id: element._id } } )
		return polledNotifications;
	}

	return []
}

export const deleteNotification = async (_id : ObjectId) => {
	await getCollection("notifications").deleteOne({_id})
}

export const scheduleNotification = async (notification : Notification) => 
{
	await getCollection("notifications").insertOne(notification)
}

const counter  = new promclient.Counter({
	name: 'apparyllis_api_notifs',
	help: 'Counter for notifs sent'
});


const sendNotification = async (notification: Notification) =>
{
	counter.inc()

	scheduleNotification(notification)
	
	// Firebase backwards support
	{
		const sendPayload = { token: notification.token, title: notification.title, body: notification.message, apns:  {headers: {	"apns-expiration": notification.expireAt.toString()}}}
		messaging()
		.send(sendPayload)
		.catch(async (error) => null);
	}
}


export const notifyUser = async (instigator: string, target: string, title: string, message: string, lifetime?: number | undefined) => {
	socketNotify(target, title, message);

	if (message.length > 1000)
	{
		message = message.substring(0, 999)
	}

	const privateCollection = getCollection("private");
	const privateData = await privateCollection.findOne({ uid: target });
	if (privateData) {

		const notificationLifetime = lifetime ?? 1000 * 60 * 60 * 6
		
		privateCollection.updateOne({ target, _id: target }, {
			$push: {
				notificationHistory: {
					$each: [
						{
							timestamp: Date.now(),
							title,
							message
						}
					],
					$slice: -30
				},
			},
		});

		const token = privateData["notificationToken"];
		if (Array.isArray(token)) {
			token.forEach((element) => {
				sendNotification({token: element, title, message, expireAt: moment.now().valueOf() + notificationLifetime, instigator, _id: undefined })
			});
		}
	}
};