const axios = require("axios");

const addSystemCompatibleAddress = (userSystemDetails) => {
    try {
        return {
            city: userSystemDetails.city,
            coordinates: [userSystemDetails.lon, userSystemDetails.lat],
            country: userSystemDetails.country,
            formattedAddress: `${userSystemDetails.city} ${userSystemDetails.regionName} ${userSystemDetails.country}`,
            state: userSystemDetails.regionName,
            street: "",
            type: "Point",
            zip: userSystemDetails.zip,
        };
    } catch (e) {
        console.log("error in adding system compatible address ", e);
    }
};

const getBrowserAndOSDetails = (browserDetails) => {
    try {
        let OSDetails = browserDetails.userAgent.split(" ");

        // Determining Device OS(Operating System)
        let operatingSystem = "Not known";
        if (OSDetails.indexOf("(Windows") !== -1) {
            operatingSystem = "Windows OS";
        }
        if (OSDetails.indexOf("Mac") !== -1) {
            operatingSystem = "MacOS";
        }
        if (OSDetails.indexOf("X11") !== -1) {
            operatingSystem = "UNIX OS";
        }
        if (OSDetails.indexOf("Linux") !== -1) {
            operatingSystem = "Linux OS";
        }

        // Determining the browser and it's version
        let nAgt = browserDetails.userAgent;
        let browserName = browserDetails.appName;
        let fullVersion = "" + parseFloat(browserDetails.appVersion);
        let majorVersion = parseInt(browserDetails.appVersion, 10);
        let nameOffset, verOffset, ix;

        // In Opera, the true version is after "OPR" or after "Version"
        if ((verOffset = nAgt.indexOf("OPR")) != -1) {
            browserName = "Opera";
            fullVersion = nAgt.substring(verOffset + 4);
            if ((verOffset = nAgt.indexOf("Version")) != -1)
                fullVersion = nAgt.substring(verOffset + 8);
        }
        // In MS Edge, the true version is after "Edg" in userAgent
        else if ((verOffset = nAgt.indexOf("Edg")) != -1) {
            browserName = "Microsoft Edge";
            fullVersion = nAgt.substring(verOffset + 4);
        }
        // In MSIE, the true version is after "MSIE" in userAgent
        else if ((verOffset = nAgt.indexOf("MSIE")) != -1) {
            browserName = "Microsoft Internet Explorer";
            fullVersion = nAgt.substring(verOffset + 5);
        }
        // In Chrome, the true version is after "Chrome"
        else if ((verOffset = nAgt.indexOf("Chrome")) != -1) {
            browserName = "Chrome";
            fullVersion = nAgt.substring(verOffset + 7);
        }
        // In Safari, the true version is after "Safari" or after "Version"
        else if ((verOffset = nAgt.indexOf("Safari")) != -1) {
            browserName = "Safari";
            fullVersion = nAgt.substring(verOffset + 7);
            if ((verOffset = nAgt.indexOf("Version")) != -1)
                fullVersion = nAgt.substring(verOffset + 8);
        }
        // In Firefox, the true version is after "Firefox"
        else if ((verOffset = nAgt.indexOf("Firefox")) != -1) {
            browserName = "Firefox";
            fullVersion = nAgt.substring(verOffset + 8);
        }
        // In most other browsers, "name/version" is at the end of userAgent
        else if (
            (nameOffset = nAgt.lastIndexOf(" ") + 1) <
            (verOffset = nAgt.lastIndexOf("/"))
        ) {
            browserName = nAgt.substring(nameOffset, verOffset);
            fullVersion = nAgt.substring(verOffset + 1);
            if (browserName.toLowerCase() == browserName.toUpperCase()) {
                browserName = browserDetails.appName;
            }
        }
        // trim the fullVersion string at semicolon/space if present
        if ((ix = fullVersion.indexOf(";")) != -1)
            fullVersion = fullVersion.substring(0, ix);
        if ((ix = fullVersion.indexOf(" ")) != -1)
            fullVersion = fullVersion.substring(0, ix);

        majorVersion = parseInt("" + fullVersion, 10);
        if (isNaN(majorVersion)) {
            fullVersion = "" + parseFloat(browserDetails.appVersion);
            majorVersion = parseInt(browserDetails.appVersion, 10);
        }

        return [operatingSystem, browserName, fullVersion];
    } catch (e) {
        console.log("error in getting Browser and OS details ", e);
    }
};

const getDeviceDetails = (userDeviceDetails) => {
    try {

        let deviceType, { isEmulator, isTablet, os: deviceOS, ...rest } = userDeviceDetails || {};

        // Checking if it's an emulator, tablet or mobile.
        if (isEmulator) {
            deviceType = "Emulator";
        } else if (isTablet) {
            deviceType = "Tablet";
        } else {
            deviceType = "Mobile";
        }

        return {
            deviceOS,
            deviceType,
            ...rest,
        };
    } catch (e) {
        console.log("error in getting device details ", e);
    }

}

const getUserSystemDetails = async (headers = {}) => {
    try {
        let userSystemDetails = {};

        // IP Address details
        let ipAddress = jsonParser(headers["ip-address"]);
        let geoJSONLatLong = {};
        if (ipAddress && Object.keys(ipAddress).length > 0) {
            await axios
                .get(
                    `http://ip-api.com/json/${ipAddress.ip}?fields=status,message,continent,continentCode,country,countryCode,region,regionName,city,district,zip,lat,lon,timezone,offset,currency,isp,org,as,asname,reverse,mobile,proxy,hosting,query`
                )
                .then(function (response) {
                    userSystemDetails = {
                        ...response.data,
                    };
                })
                .catch(function (error) {
                    console.log("error in getting ipAddress details", error);
                });

            //Adding system compatible address
            geoJSONLatLong = addSystemCompatibleAddress(userSystemDetails);
            userSystemDetails = {
                ...userSystemDetails,
                geoJSONLatLong,
                ipAddress: userSystemDetails.query,
            };
        }

        // Browser and Device OS Details
        let browserDetails = jsonParser(headers["browser-details"]);
        let deviceDetails = jsonParser(headers["device-details"]);
        if (browserDetails && Object.keys(browserDetails).length > 0) {
            let details = getBrowserAndOSDetails(browserDetails);

            userSystemDetails = {
                ...userSystemDetails,
                browserName: details[1],
                browserVersion: details[2],
                deviceOS: details[0],
                platform: "webApplication",
            };
            delete userSystemDetails.status;
            delete userSystemDetails.query;
        } else if (deviceDetails && Object.keys(deviceDetails).length > 0) {
            let details = getDeviceDetails(deviceDetails) || {};
            userSystemDetails = {
                ...userSystemDetails,
                ...details,
                platform: "mobileApplication",
            }
        }
        return userSystemDetails;
    } catch (e) {
        console.log("error in getting UserSystemDetails ", e);
    }
};

const jsonParser = (str) => {
    if (str === undefined || str === null) {
        return null;
    }

    if (typeof str === "object") {
        return str;
    }

    let normalizedString = String(str).trim();
    if (
        normalizedString === "" ||
        normalizedString === "undefined" ||
        normalizedString === "null"
    ) {
        return null;
    }

    try {
        return JSON.parse(normalizedString);
    } catch (e) {
        console.log("error in parsing json ", e);
        return null;
    }
};

module.exports = {
    getUserSystemDetails,
};
