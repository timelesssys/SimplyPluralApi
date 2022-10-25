import { randomBytes } from "crypto";
import { readFile } from "fs";
import moment from "moment";
import { promisify } from "util";
import { mailerTransport } from "../../../modules/mail";
import { getCollection } from "../../../modules/mongo";
import * as Sentry from "@sentry/node";
import { auth } from "firebase-admin";
import { assert } from "console";
import { hash } from "./auth.hash";

//-------------------------------//
// Generate a new random reset password key
//-------------------------------//
export const getResetPasswordKey = () => randomBytes(64).toString("hex")

//-------------------------------//
// Request password reset link
//-------------------------------//
export const resetPasswordRequest_Execution = async (email : string) : Promise<{success: boolean, msg: string, url: string}> => {
	let resetUrl = "";

	const user = await getCollection("accounts").findOne({email})
	if (user)
	{
		if (user.lastResetPasswordEmailSent)
		{
			const lastTimestamp = user.lastResetPasswordEmailSent
			if (moment.now() - (1000 * 60) < lastTimestamp)
			{
				return {success: false, msg: "Request password links can only be requested once every minute", url: ""};
			}
		}
		const resetKey = getResetPasswordKey();
		resetUrl = `https://api.apparyllis.com/v1/auth/verification/resetpassword?key=${resetKey}`;
		await getCollection("accounts").updateOne({email}, { $set: { lastResetPasswordEmailSent: moment.now(), passwordResetToken: resetKey}})
	}
	else 
	{
		const firebaseUser = await auth().getUserByEmail(email)
		if (firebaseUser)
		{
			resetUrl = await auth().generatePasswordResetLink(email);	
		}
		else 
		{
			return {success: false, msg: "User not found", url: ""};
		}		
	}
	
	const getFile = promisify(readFile);
	let emailTemplate = await getFile("./templates/resetPasswordEmail.html", "utf-8");

	// This template has the url twice
	emailTemplate = emailTemplate.replace("{{resetUrl}}", resetUrl)
	emailTemplate = emailTemplate.replace("{{resetUrl}}", resetUrl)

	const result : any = await mailerTransport?.sendMail({
		from: '"Apparyllis" <noreply@apparyllis.com>',
		to: email,
		html: emailTemplate,
		subject: "Reset your Simply Plural account password",
	}).catch((reason) => {err: reason.toString() as string})

	if (result && result.err)
	{
		Sentry.captureMessage(result.err.toString())
		return {success: false, msg: "Failed to send reset password email, does the email exist?", url: ""};
	}

	return {success: true, msg: "", url: resetUrl};
}

//-------------------------------//
// Reset password execution
//-------------------------------//
export const resetPassword_Exection = async (resetKey : string, newPassword: string) : Promise<{success: boolean, msg: string, uid: string}> => {
	const user = await getCollection("accounts").findOne({passwordResetToken: resetKey})
	if (user)
	{
		assert(resetKey === user.passwordResetToken)

		const lastTimestamp = user.lastResetPasswordEmailSent
		if (moment.now() > lastTimestamp + (1000 * 60 * 60))
		{
			await getCollection("accounts").updateOne({uid: user.uid}, { $unset: { resetKey: "" } })
			return {success:false, msg: "Reset key is no longer valid" , uid: ''}
		}

		const salt = randomBytes(16).toString("hex")
		const hashedPasswd = await hash(newPassword, salt)
		await getCollection("accounts").updateOne({uid: user.uid}, { $set: { password: hashedPasswd.hashed, salt: salt },  $unset: { resetKey: "" } })

		return {success:true, msg:"", uid: user.uid}
	}
	else 
	{
		return {success:false, msg:"Invalid reset key", uid: ''}
	}
}