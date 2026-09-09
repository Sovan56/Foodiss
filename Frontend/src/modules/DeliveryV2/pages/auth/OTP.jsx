import { useState, useEffect, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { deliveryAPI } from "@food/api"
import { setAuthData as storeAuthData } from "@food/utils/auth"
import { resolveDeviceFcmToken, registerWebPushForCurrentModule } from "@food/utils/firebaseMessaging"
import { useCompanyName } from "@food/hooks/useCompanyName"
import { motion, AnimatePresence } from "framer-motion"
import { Loader2, AlertCircle, FastForward, ArrowLeft, CheckCircle2, ShieldCheck } from "lucide-react"
import { Input } from "@food/components/ui/input"
import { Button } from "@food/components/ui/button"

export default function DeliveryOTP() {
  const companyName = useCompanyName()
  const navigate = useNavigate()
  const [otp, setOtp] = useState(["", "", "", ""])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState(false)
  const [resendTimer, setResendTimer] = useState(0)
  const [authData, setAuthData] = useState(null)
  const [showNameInput, setShowNameInput] = useState(false)
  const [name, setName] = useState("")
  const [nameError, setNameError] = useState("")
  const [verifiedOtp, setVerifiedOtp] = useState("")
  const [pendingMessage, setPendingMessage] = useState("")
  const [isRejected, setIsRejected] = useState(false)
  const [isDeactivated, setIsDeactivated] = useState(false)
  const [rejectionReason, setRejectionReason] = useState("")
  const [deviceToken, setDeviceToken] = useState(null)
  const [activePlatform, setActivePlatform] = useState("web")
  const inputRefs = useRef([])

  useEffect(() => {
    const stored = sessionStorage.getItem("deliveryAuthData")
    if (stored) {
      setAuthData(JSON.parse(stored))
    } else {
      const token = localStorage.getItem("delivery_accessToken")
      const authenticated = localStorage.getItem("delivery_authenticated") === "true"
      if (token && authenticated) {
        try {
          const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")))
          if (payload.exp > Math.floor(Date.now() / 1000)) {
            navigate("/food/delivery", { replace: true })
            return
          }
        } catch (e) {
          // ignore invalid token
        }
      }
      navigate("/food/delivery/login", { replace: true })
      return
    }

    setResendTimer(60)
    const timer = setInterval(() => {
      setResendTimer((prev) => {
        if (prev <= 1) {
          clearInterval(timer)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [navigate])

  useEffect(() => {
    if (inputRefs.current[0] && !showNameInput && !pendingMessage) {
      setTimeout(() => inputRefs.current[0]?.focus(), 100)
    }
  }, [showNameInput, pendingMessage])

  const handleChange = (index, value) => {
    if (value && !/^\d$/.test(value)) return
    const newOtp = [...otp]
    newOtp[index] = value
    setOtp(newOtp)
    setError("")
    if (value && index < 3) inputRefs.current[index + 1]?.focus()
    if (!showNameInput && newOtp.every((digit) => digit !== "") && newOtp.length === 4) {
      handleVerify(newOtp.join(""))
    }
  }

  const handleKeyDown = (index, e) => {
    if (e.key === "Backspace") {
      if (otp[index]) {
        const newOtp = [...otp]
        newOtp[index] = ""
        setOtp(newOtp)
      } else if (index > 0) {
        inputRefs.current[index - 1]?.focus()
        const newOtp = [...otp]
        newOtp[index - 1] = ""
        setOtp(newOtp)
      }
    }
  }

  const handlePaste = (e) => {
    e.preventDefault()
    const digits = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 4).split("")
    const newOtp = [...otp]
    digits.forEach((digit, i) => {
      if (i < 4) newOtp[i] = digit
    })
    setOtp(newOtp)
    if (!showNameInput && digits.length === 4) handleVerify(newOtp.join(""))
    else inputRefs.current[digits.length]?.focus()
  }

  const handleVerify = async (otpValue = null) => {
    if (showNameInput || pendingMessage) return
    const code = otpValue || otp.join("")
    if (code.length !== 4) return
    setIsLoading(true)
    setError("")
    try {
      const phone = authData?.phone
      const purpose = authData?.purpose || "login"
      let fcmToken = null
      let platform = "web"
      try {
        const resolved = await resolveDeviceFcmToken("delivery", { allowPrompt: true })
        fcmToken = resolved?.token || null
        platform = resolved?.platform || "web"
      } catch (e) {
        // continue without FCM token
      }
      setDeviceToken(fcmToken)
      setActivePlatform(platform)

      const response = await deliveryAPI.verifyOTP(phone, code, purpose, null, fcmToken, platform)
      const data = response?.data?.data || response?.data || {}

      if (data.pendingApproval === true || data.isRejected || data.isDeactivated) {
        setIsLoading(false)
        setPendingMessage(data.message)
        setIsRejected(data.isRejected || false)
        setIsDeactivated(data.isDeactivated || false)
        setRejectionReason(data.rejectionReason || "")
        return
      }

      if (data.needsRegistration === true) {
        sessionStorage.removeItem("deliveryAuthData")
        sessionStorage.setItem("deliveryNeedsRegistration", "true")
        sessionStorage.setItem(
          "deliverySignupDetails",
          JSON.stringify({ name: "", phone: phone.replace(/\D/g, "").slice(-10), countryCode: "+91" })
        )
        setIsLoading(false)
        navigate("/food/delivery/signup/details", { replace: true })
        return
      }

      const { accessToken, refreshToken, user } = data
      if (accessToken && user) {
        storeAuthData("delivery", accessToken, user, refreshToken)
        window.dispatchEvent(new Event("deliveryAuthChanged"))
        registerWebPushForCurrentModule("/food/delivery", { force: true }).catch(() => {})
        setSuccess(true)
        setTimeout(() => navigate("/food/delivery", { replace: true }), 800)
      }
    } catch (err) {
      setError(err?.response?.data?.message || "Invalid code.")
      setIsLoading(false)
    }
  }

  const handleSubmitName = async () => {
    if (!name.trim()) {
      setNameError("Name required")
      return
    }
    setIsLoading(true)
    setError("")
    try {
      const response = await deliveryAPI.verifyOTP(
        authData?.phone,
        verifiedOtp,
        authData?.purpose || "login",
        name.trim(),
        deviceToken,
        activePlatform
      )
      const { accessToken, refreshToken, user } = response?.data?.data || response?.data || {}
      if (accessToken && user) {
        storeAuthData("delivery", accessToken, user, refreshToken)
        window.dispatchEvent(new Event("deliveryAuthChanged"))
        registerWebPushForCurrentModule("/food/delivery", { force: true }).catch(() => {})
        setSuccess(true)
        setTimeout(() => navigate("/food/delivery", { replace: true }), 800)
      }
    } catch (err) {
      setError("Failed to complete setup.")
    } finally {
      setIsLoading(false)
    }
  }

  const handleResend = async () => {
    if (resendTimer > 0) return
    setIsLoading(true)
    setError("")
    try {
      await deliveryAPI.sendOTP(authData?.phone, authData?.purpose || "login")
      setResendTimer(60)
      setOtp(["", "", "", ""])
      setShowNameInput(false)
      setName("")
      setVerifiedOtp("")
    } catch (err) {
      setError("Failed to resend code.")
    } finally {
      setIsLoading(false)
    }
  }

  if (!authData) return null

  return (
    <div className="min-h-[100dvh] bg-zinc-50 flex flex-col font-sans overflow-hidden relative selection:bg-[#0D9488]/10">
      <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-20%] w-[100%] h-[50%] bg-[#0D9488]/10 skew-y-[-12deg] transform-gpu" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-white/80 to-white" />
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 relative z-10 py-12">
        <div className="w-full max-w-md">
          <motion.div
            initial={{ x: -50, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            className="mb-12"
          >
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="p-3 bg-white border border-zinc-100 rounded-2xl shadow-sm mb-8 hover:bg-zinc-50 transition-colors"
            >
              <ArrowLeft className="w-5 h-5 text-zinc-900" />
            </button>

            <div className="flex items-center gap-3 mb-6">
              <div className="p-3 bg-[#0D9488] rounded-2xl shadow-lg">
                <ShieldCheck className="w-8 h-8 text-white" />
              </div>
              <div className="h-px flex-1 bg-gradient-to-r from-[#0D9488] to-transparent opacity-20" />
            </div>

            <h1 className="text-4xl font-black text-zinc-900 italic tracking-tighter leading-none mb-2">
              {showNameInput ? (
                <>CAPTAIN <span className="text-[#0D9488] not-italic opacity-80 font-light italic">SETUP</span></>
              ) : pendingMessage ? (
                <>SHIFT <span className="text-[#0D9488] not-italic opacity-80 font-light italic">{isRejected ? "DENIED" : "PENDING"}</span></>
              ) : (
                <>SECURITY <span className="text-[#0D9488] not-italic opacity-80 font-light italic">VERIFY</span></>
              )}
            </h1>
            <p className="text-[#0D9488] text-[10px] font-black uppercase tracking-[0.4em] opacity-50">
              {showNameInput ? "Complete your profile" : pendingMessage ? "Verification required" : "Shift Authentication"}
            </p>
          </motion.div>

          <motion.div
            initial={{ y: 30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.1 }}
            className="bg-white border border-zinc-100 rounded-[2.5rem] p-8 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.06)] relative overflow-hidden"
          >
            <AnimatePresence mode="wait">
              {!pendingMessage ? (
                <motion.div
                  key="otp"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                >
                  {!showNameInput ? (
                    <div className="space-y-10">
                      <div className="mb-10">
                        <h2 className="text-2xl font-black text-zinc-900 tracking-tight mb-2">Check your phone</h2>
                        <p className="text-zinc-500 text-sm font-medium">
                          Enter code sent to <span className="text-zinc-900 font-bold">{authData?.phone}</span>
                        </p>
                      </div>

                      <div className="flex justify-center gap-2 sm:gap-4">
                        {otp.map((digit, index) => (
                          <input
                            key={index}
                            ref={(el) => (inputRefs.current[index] = el)}
                            type="tel"
                            inputMode="numeric"
                            maxLength={1}
                            value={digit}
                            onChange={(e) => handleChange(index, e.target.value)}
                            onKeyDown={(e) => handleKeyDown(index, e)}
                            onPaste={index === 0 ? handlePaste : undefined}
                            disabled={isLoading}
                            className="w-14 h-16 sm:w-16 sm:h-20 text-center text-2xl sm:text-3xl font-black bg-zinc-50 border-2 border-zinc-100 focus:border-[#0D9488] focus:bg-white rounded-2xl text-zinc-900 transition-all outline-none focus:shadow-sm"
                            placeholder="•"
                          />
                        ))}
                      </div>

                      {error && (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="flex items-center justify-center gap-2 text-xs font-bold text-[#0D9488] bg-[#0D9488]/5 py-3 rounded-xl"
                        >
                          <AlertCircle size={14} />
                          <span>{error}</span>
                        </motion.div>
                      )}

                      <div className="flex flex-col items-center gap-6">
                        {resendTimer > 0 ? (
                          <p className="text-xs font-black text-zinc-400 uppercase tracking-widest">
                            Resend in <span className="text-[#0D9488]">{resendTimer}s</span>
                          </p>
                        ) : (
                          <button
                            type="button"
                            onClick={handleResend}
                            disabled={isLoading}
                            className="text-xs font-black text-[#0D9488] uppercase tracking-widest underline underline-offset-8 decoration-2"
                          >
                            Resend Now
                          </button>
                        )}

                        <Button
                          onClick={() => handleVerify()}
                          disabled={isLoading || otp.some((d) => !d)}
                          className="w-full h-16 bg-[#0D9488] hover:bg-[#0F766E] text-white font-black text-base tracking-widest uppercase rounded-2xl transition-all shadow-[0_12px_24px_rgba(13,148,136,0.3)] flex items-center justify-center gap-2 group"
                        >
                          {isLoading ? <Loader2 className="w-6 h-6 animate-spin" /> : (
                            <>
                              <span>Verify & Go Online</span>
                              <FastForward className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-8">
                      <div className="space-y-4">
                        <label className="text-[10px] font-black text-zinc-400 uppercase tracking-[0.3em] ml-1">
                          Official Full Name
                        </label>
                        <div className="bg-zinc-50 border border-zinc-200 rounded-2xl focus-within:border-[#0D9488]/50 focus-within:ring-4 focus-within:ring-[#0D9488]/5 transition-all overflow-hidden">
                          <Input
                            type="text"
                            value={name}
                            onChange={(e) => {
                              setName(e.target.value)
                              setNameError("")
                            }}
                            disabled={isLoading}
                            placeholder="e.g. Aman Kuril"
                            className="h-16 bg-transparent border-0 ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 text-xl font-black px-6 text-zinc-900"
                          />
                        </div>
                        {nameError && <p className="text-xs font-bold text-red-500 pl-2">{nameError}</p>}
                      </div>

                      <Button
                        onClick={handleSubmitName}
                        disabled={isLoading || name.trim().length < 2}
                        className="w-full h-16 bg-[#0D9488] hover:bg-[#0F766E] text-white font-black text-base uppercase tracking-widest rounded-2xl transition-all shadow-[0_12px_24px_rgba(13,148,136,0.3)]"
                      >
                        {isLoading ? <Loader2 className="w-6 h-6 animate-spin" /> : "Start Riding"}
                      </Button>
                    </div>
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="pending"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="text-center space-y-8"
                >
                  <div
                    className={`w-20 h-20 mx-auto rounded-3xl flex items-center justify-center shadow-xl transform rotate-12 ${
                      isRejected
                        ? "bg-red-50 text-red-600 border border-red-100"
                        : isDeactivated
                          ? "bg-zinc-100 text-zinc-500 border border-zinc-200"
                          : "bg-[#0D9488]/10 text-[#0D9488] border border-[#0D9488]/10"
                    }`}
                  >
                    {isRejected ? (
                      <AlertCircle size={40} className="-rotate-12" />
                    ) : isDeactivated ? (
                      <ShieldCheck size={40} className="-rotate-12" />
                    ) : (
                      <ShieldCheck size={40} className="-rotate-12" />
                    )}
                  </div>

                  <div className="space-y-3">
                    <h3
                      className={`text-xl font-black italic uppercase tracking-tight ${
                        isRejected ? "text-red-600" : isDeactivated ? "text-zinc-500" : "text-[#0D9488]"
                      }`}
                    >
                      {isRejected ? "Shift Denied" : isDeactivated ? "Account Deactivated" : "Pending Approval"}
                    </h3>
                    <p className="text-sm font-medium text-zinc-500 leading-relaxed">{pendingMessage}</p>
                  </div>

                  {isRejected && rejectionReason && (
                    <div className="bg-red-50 p-5 rounded-2xl border border-red-100">
                      <p className="text-[10px] font-black text-red-400 uppercase tracking-widest mb-1 italic">
                        Fleet Feedback
                      </p>
                      <p className="text-sm text-red-700 font-medium italic">&ldquo;{rejectionReason}&rdquo;</p>
                    </div>
                  )}

                  <div className="pt-6 flex flex-col gap-4">
                    {isRejected && (
                      <Button
                        onClick={() => navigate("/food/delivery/signup/details")}
                        className="w-full h-16 rounded-2xl font-black bg-red-600 hover:bg-red-700 text-white shadow-lg"
                      >
                        RE-APPLY NOW
                      </Button>
                    )}
                    <button
                      type="button"
                      onClick={() => navigate("/food/delivery/login")}
                      className="text-[10px] font-black text-zinc-400 uppercase tracking-[0.4em] hover:text-[#0D9488] transition-all"
                    >
                      BACK TO BASE
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          <footer className="mt-12 text-center">
            <p className="text-[10px] text-zinc-300 font-bold uppercase tracking-[0.4em]">
              Fleet Security Network &bull; {companyName.toUpperCase()}
            </p>
          </footer>
        </div>
      </div>

      <AnimatePresence>
        {success && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="fixed inset-0 z-[100] bg-white flex flex-col items-center justify-center p-6 text-center"
          >
            <motion.div
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", damping: 15 }}
              className="w-24 h-24 bg-[#0D9488]/10 rounded-full flex items-center justify-center mb-8"
            >
              <CheckCircle2 className="w-12 h-12 text-[#0D9488]" />
            </motion.div>
            <h2 className="text-3xl font-black text-zinc-900 tracking-tight italic mb-2">
              SYSTEMS <span className="text-[#0D9488]">ONLINE</span>
            </h2>
            <p className="text-zinc-500 font-medium">Captain authenticated successfully</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
