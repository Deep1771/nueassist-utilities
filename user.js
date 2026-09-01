function isNJAdmin(user=null){
    if(user){
        let {role} = user.sys_entityAttributes || {}
        if(role && role.toUpperCase() === 'ASSETGOV-ADMIN'){
            return true
        }else{
            return false
        }
    }else{
        return false
    }
}

function isSuperAdmin(user=null){
    if(user){
        let {superAdmin} = user.sys_entityAttributes || {}
        if(superAdmin){
            return true
        }
        else{
            return false
        }
    }else{
        return false
    }
}

function getUserAgency(user){
    if(!isNJAdmin(user)){
        let {agencyuser} = (user && user.sys_entityAttributes) || {}
        if(agencyuser){
            return agencyuser
        }else return false
    }else return false
}

function getUserRole(user){
    if(!isNJAdmin(user) && !isSuperAdmin(user)){
        let {roleName} = (user && user.sys_entityAttributes) || {}
        if(roleName){
            return roleName
        }else return false
    }else return false
}

module.exports = {
    getUserAgency,
    getUserRole,
    isNJAdmin,
    isSuperAdmin
}
